import { templates as defaultTemplates } from './templates.js';

export function eventParser(event) {

    let messageBody = {};

    for (const record of event.Records) {
        try {
            // The SQS message body is a JSON string, so parse it

            const eventBody = JSON.parse(record.body);

            const eventType = eventBody?.data?.MessageHeader?.InitiatingEventText; //.toUppercase().split(' ').join('_'); 
            const priorityType = eventBody?.data?.Body?.Rx?.PriorityTypeText;
            const rxTransactionStatus = eventBody?.data?.Body?.Rx?.CurrentRxTransactionStatusText.split(' ').join('');

            const condition = `${eventType}_${rxTransactionStatus}_${priorityType}`

            const firstName = eventBody?.data?.Body?.Patient?.Name?.FirstName;
            const lastName = eventBody?.data?.Body?.Patient?.Name?.LastName;
            const patientPhoneNumber = eventBody?.data?.Body?.Patient?.PhoneNumbers?.PhoneNumber[0]?.AreaCode + eventBody?.data?.Body?.Patient?.PhoneNumbers?.PhoneNumber[0]?.Number;
            const trackingLink = eventBody?.data?.Body?.Rx?.TrackingNumber;
            const directionsLink = '8740 N Kendall Drive Suite 106, Miami, FL 33176';
            const prescriberNpi = eventBody?.data?.Body?.Prescribers?.Prescriber[0]?.Identification?.NPI;
            const notifyTypeText = eventBody?.data?.Body?.Patient?.RxNotifyTypeText;
            const rxId = eventBody?.data?.Body?.Rx?.RxPioneerRxID;

            messageBody["condition"] = condition;
            messageBody["templateParams"] = { firstName, trackingLink, directionsLink };
            messageBody["firstName"] = firstName;
            messageBody["lastName"] = lastName;
            messageBody["phoneNumber"] = patientPhoneNumber;
            messageBody["prescriberNpi"] = prescriberNpi;
            messageBody["patientId"] = eventBody?.data?.Body?.Patient?.Identification?.PatientPioneerRxID;
            messageBody["messageId"] = getMessageId(rxTransactionStatus);
            messageBody["notifyTypeText"] = notifyTypeText;
            messageBody["rxId"] = rxId

        } catch (error) {
            throw error;
        }
    }

    return messageBody;

}

function renderTemplate(template, params) {
    return template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
  }

export function getMessage(condition, params, templates = null) {
    const templateSource = templates || defaultTemplates;
    const template = templateSource[condition];
    if (!template) throw new Error(`No template found for ${condition}`);
    return renderTemplate(template, params);
}

// TODO: Update this once the actual on-hold event shape is known
export function isOnHoldEvent(condition) {
    return condition && condition.toLowerCase().includes('onhold');
}

function getMessageId(rxTransactionStatus) {
    switch (rxTransactionStatus) {
        case 'WaitingforCheck':
            return 1;
        case 'WaitingforPickup':
            return 2;
        case 'Completed':
            return 3;
        default:
            return 0;
    }
}