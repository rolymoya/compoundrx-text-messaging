import fetch from "node-fetch";
import { eventParser, getMessage, isOnHoldEvent } from './parser.js';
import { readIdsFromS3Env } from './s3FileReader.js';
import { isDuplicateMessage, saveMessage, getTemplatesForNpi, saveOnHoldPatient, deleteOnHoldPatient } from './dbUtils.js';

const baseUrl = "https://api.podium.com/v4/";
const refreshToken = process.env.REFRESHTOKEN;
const clientID = process.env.CLIENTID;
const clientSecret = process.env.CLIENTSECRET;

export const handler = async (event, context) => {

  // --- API Gateway event (Podium STOP webhook) ---
  if (event.body) {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

    if (body.action === 'podium_stop_webhook') {
      return handleStopWebhook(body);
    }
  }

  // --- SQS event (PioneerRx) ---
  let messageBody;

  try{
    messageBody = eventParser(event);
  }catch(error){
    console.error("Error while parsing event: ", error);
    return {
      statusCode: 200,
    };
  }

  if (!messageBody || !messageBody.condition) {
    return {
      statusCode: 200,
    };
  }

  // On-hold event — save patient for weekly reminders and return
  if (isOnHoldEvent(messageBody.condition)) {
    console.log(`On-hold event detected for patient ${messageBody.patientId}`);
    const result = await saveOnHoldPatient(
      messageBody.patientId,
      messageBody.phoneNumber,
      messageBody.templateParams?.firstName
    );
    if (!result.success) {
      console.error('Failed to save on-hold patient:', result.error);
    }
    return { statusCode: 200 };
  }

  // Fetch templates for this NPI (falls back to default)
  let templates;
  try {
    templates = await getTemplatesForNpi(messageBody.prescriberNpi);
  } catch (error) {
    console.error("Error fetching templates:", error);
  }

  // Generate the message using fetched templates (or fallback to hardcoded)
  try {
    messageBody.message = getMessage(
      messageBody.condition,
      messageBody.templateParams,
      templates
    );
  } catch (error) {
    console.error("Error generating message:", error);
    return {
      statusCode: 200,
    };
  }

  if (messageBody.notifyTypeText == "Yes") {
    const isDupe = await isDuplicateMessage(messageBody);

    if (isDupe) {
      console.log("Duplicate message detected, not sending to Podium.");
      return {
        statusCode: 200,
      };
    }

    console.log("message body for response: " + JSON.stringify(messageBody));
    return callPodium(messageBody);
  }

  return {
    statusCode: 200,
  };
};

// Handle Podium STOP webhook — remove patient from on-hold table
async function handleStopWebhook(body) {
  // TODO: Adjust based on actual Podium webhook payload shape
  const phoneNumber = body.phoneNumber || body.phone_number;

  if (!phoneNumber) {
    console.error('STOP webhook missing phone number');
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing phone number' }) };
  }

  console.log(`STOP received for ${phoneNumber}, removing from on-hold list`);
  const result = await deleteOnHoldPatient(phoneNumber);

  if (!result.success) {
    console.error('Failed to delete on-hold patient:', result.error);
    return { statusCode: 500, body: JSON.stringify({ error: result.error }) };
  }

  return { statusCode: 200, body: JSON.stringify({ removed: phoneNumber }) };
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
      console.error('Podium API error:', errorData);
    }
    
    else{
      const saveMsg = await saveMessage(messageBody); 
  
      if (!saveMsg.success) {
        console.error('Failed to save message:', saveMsg.error);
      }
    }

    return {
      statusCode: response.status,
    };

  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}
