import fetch from "node-fetch";
import { eventParser, getMessage, isOnHoldEvent } from './parser.js';
import { readIdsFromS3Env } from './s3FileReader.js';
import { isDuplicateMessage, saveMessage, getTemplatesForNpi, saveOnHoldPatient } from './dbUtils.js';

const baseUrl = "https://api.podium.com/v4/";
const refreshToken = process.env.REFRESHTOKEN;
const clientID = process.env.CLIENTID;
const clientSecret = process.env.CLIENTSECRET;

// TCPA-compliant texting window: only send between 8am and 9pm pharmacy-local
// time. Also filters out the duplicate shipment events PioneerRx replays at 4am.
const PHARMACY_TIMEZONE = "America/New_York";
const SEND_WINDOW_START_HOUR = 8;  // 8am
const SEND_WINDOW_END_HOUR = 21;   // 9pm

function isOutsideSendWindow(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: PHARMACY_TIMEZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).format(date));
  return hour < SEND_WINDOW_START_HOUR || hour >= SEND_WINDOW_END_HOUR;
}

export const handler = async (event, context) => {

  let messageBodies;

  try{
    messageBodies = eventParser(event);
  }catch(error){
    console.error("Error while parsing event: ", error);
    return {
      statusCode: 200,
    };
  }

  let failureCount = 0;

  for (const messageBody of messageBodies) {
    try {
      await processMessage(messageBody);
    } catch (error) {
      console.error(`Error processing message: | Patient: ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}`, error);
      failureCount++;
    }
  }

  if (failureCount > 0) {
    // Fail the invocation so SQS redelivers the batch; already-sent
    // messages are skipped on retry by the duplicate check
    throw new Error(`${failureCount} of ${messageBodies.length} messages failed to process`);
  }

  return {
    statusCode: 200,
  };
};

async function processMessage(messageBody) {

  if (!messageBody || !messageBody.condition) {
    return {
      statusCode: 200,
    };
  }

  const patientTag = ` | Patient: ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}`;

  // Check if this is an on-hold event — save patient and return. Not gated by
  // the send window since this only persists state, it doesn't send a text.
  if (isOnHoldEvent(messageBody.condition)) {
    console.log(`On-hold event detected for patient ${messageBody.patientId}${patientTag}`);
    const result = await saveOnHoldPatient(
      messageBody.patientId,
      messageBody.phoneNumber,
      messageBody.templateParams?.firstName
    );
    if (!result.success) {
      console.error(`Failed to save on-hold patient:${patientTag}`, result.error);
    }
    return { statusCode: 200 };
  }

  if (isOutsideSendWindow()) {
    console.log(`Event received outside ${SEND_WINDOW_START_HOUR}:00-${SEND_WINDOW_END_HOUR}:00 ${PHARMACY_TIMEZONE} send window, dropping message.${patientTag}`);
    return {
      statusCode: 200,
    };
  }

  // Fetch templates for this NPI (falls back to default)
  let templates;
  try {
    templates = await getTemplatesForNpi(messageBody.prescriberNpi, messageBody.firstName, messageBody.lastName);
  } catch (error) {
    console.error(`Error fetching templates:${patientTag}`, error);
  }

  // Generate the message using fetched templates (or fallback to hardcoded)
  try {
    messageBody.message = getMessage(
        messageBody.condition,
        messageBody.templateParams,
        templates
    );
  } catch (error) {
    console.error(`Error generating message for ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}:`, error);
    return {
      statusCode: 200,
    };
  }

  if (messageBody.notifyTypeText == "Yes") {
    console.log(`message body for response:${patientTag} ` + JSON.stringify(messageBody));

    const isDupe = await isDuplicateMessage(messageBody);

    if (isDupe) {
      console.log(`Duplicate message detected, not sending to Podium.${patientTag}`);
      return {
        statusCode: 200,
      };
    }

    return callPodium(messageBody);
  }

  return {
    statusCode: 200,
  };
}

async function syncContact(token, phoneNumber, firstName, lastName, prescriberNpi, prescriberFirstName, prescriberLastName) {
  console.info("Syncing contact to Podium: ", phoneNumber, firstName, lastName, prescriberNpi)
  const name = [firstName, lastName].filter(Boolean).join(' ');
  const prescriberName = [prescriberFirstName, prescriberLastName].filter(Boolean).join(' ');

  const contactPayload = {
    name,
    phoneNumber,
    locations: ["019499ac-a1e9-7ede-b6e8-f54fdabf0ae1"],
    attributes: [
      { uid: "019cd36c-639e-7ee9-9f21-a06b1c3cf2e5", value: prescriberNpi },
      { uid: "019cd81c-085d-75ba-a11a-3b5b287abdc0", value: prescriberName }
    ]
  };

  const response = await fetch(`${baseUrl}contacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(contactPayload),
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error(`Podium contact sync error: | Patient: ${firstName ?? ''} ${lastName ?? ''}`, errorData);
  } else {
    console.log(`Contact synced for ${name} (${phoneNumber})`);
  }
}

async function getTokenID() {
  const bodyData = {
    client_id: clientID,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };

  try {
    const tokenRequest = await fetch(
        "https://accounts.podium.com/oauth/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyData),
        },
    );

    const tokenResponse = await tokenRequest.json();

    if (tokenResponse) {
      return tokenResponse.access_token;
    }
  } catch (error) {
    console.error(`Error retrieving a new token, ${error}`);
    return null;
  }
}

async function callPodium(messageBody){

  const patientTag = ` | Patient: ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}`;

  try {
    // Get fresh access token
    const token = await getTokenID();

    if (!token) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "No authorization token was found." })
      };
    }

    // Create your message payload
    const messagePayload = {
      locationUid: "019499ac-a1e9-7ede-b6e8-f54fdabf0ae1", // or from event/params
      body: messageBody.message,
      channel: {
        type: "phone",
        identifier: messageBody.phoneNumber
      }
      // Add other required fields
    };

    // Make the API call to Podium
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(messagePayload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`Podium API error:${patientTag}`, errorData);
    }

    else{
      const saveMsg = await saveMessage(messageBody);

      if (!saveMsg.success) {
        console.error(`Failed to save message:${patientTag}`, saveMsg.error);
      }

      syncContact(token,
          messageBody.phoneNumber,
          messageBody.firstName,
          messageBody.lastName,
          messageBody.prescriberNpi,
          messageBody.prescriberFirstName,
          messageBody.prescriberLastName)
          .catch(err => console.error(`Contact sync failed (non-critical):${patientTag}`, err));
    }

    return {
      statusCode: response.status,
    };

  } catch (error) {
    console.error(`${patientTag}`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}
