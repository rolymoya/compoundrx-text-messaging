import { templates as defaultTemplates } from './templates.js';

export function eventParser(event) {

    const messageBodies = [];

    for (const record of event.Records) {
        const messageBody = {};
        try {
            // The SQS message body is a JSON string, so parse it

            const eventBody = JSON.parse(record.body);

            const firstName = eventBody?.data?.Body?.Patient?.Name?.FirstName;
            const lastName = eventBody?.data?.Body?.Patient?.Name?.LastName;
            messageBody["firstName"] = firstName;
            messageBody["lastName"] = lastName;

            const eventType = eventBody?.data?.MessageHeader?.InitiatingEventText; //.toUppercase().split(' ').join('_');
            const priorityType = eventBody?.data?.Body?.Rx?.PriorityTypeText;
            const rxTransactionStatus = eventBody?.data?.Body?.Rx?.CurrentRxTransactionStatusText.split(' ').join('');

            const condition = `${eventType}_${rxTransactionStatus}_${priorityType}`
            const areaCode = eventBody?.data?.Body?.Patient?.PhoneNumbers?.PhoneNumber[0]?.AreaCode;
            const number = eventBody?.data?.Body?.Patient?.PhoneNumbers?.PhoneNumber[0]?.Number;
            const patientPhoneNumber = `+1${areaCode}${number}`;
            const trackingLink = eventBody?.data?.Body?.Rx?.TrackingNumber;
            const directionsLink = '8740 N Kendall Drive Suite 106, Miami, FL 33176';
            const prescriberNpi = eventBody?.data?.Body?.Prescribers?.Prescriber[0]?.Identification?.NPI;
            const notifyTypeText = eventBody?.data?.Body?.Patient?.RxNotifyTypeText;
            const rxId = eventBody?.data?.Body?.Rx?.RxPioneerRxID;

            messageBody["condition"] = condition;
            messageBody["templateParams"] = { firstName, trackingLink, directionsLink };
            messageBody["phoneNumber"] = patientPhoneNumber;
            messageBody["prescriberNpi"] = prescriberNpi;
            messageBody["patientId"] = eventBody?.data?.Body?.Patient?.Identification?.PatientPioneerRxID;
            messageBody["messageId"] = getMessageId(rxTransactionStatus);
            messageBody["notifyTypeText"] = notifyTypeText;
            messageBody["rxId"] = rxId

            messageBodies.push(messageBody);

        } catch (error) {
            // Skip the bad record but keep processing the rest of the batch
            console.error(`Error parsing SQS record: | Patient: ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}`, error);
        }
    }

    return messageBodies;

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