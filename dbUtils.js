import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
export async function isDuplicateMessage(messageBody) {
  const patientTag = ` | Patient: ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}`;
  try {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('recent_messages')
      .select('*')
      .eq('patient_id', messageBody.patientId)
      .eq('rx_id', messageBody.rxId)
      .eq('condition', messageBody.condition)
      .gte('created_at', fiveHoursAgo);

    if (error) {
      console.error(`Database error checking duplicate:${patientTag}`, error);
      throw error; // Let caller handle the error
    }

    return data.length > 0;

  } catch (error) {
    console.error(`Error checking for duplicate message:${patientTag}`, error.message);
    throw error; // Re-throw so caller knows something went wrong
  }
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_API_KEY
  );

//checks if a record exists in the recent_messages table that was created within the last 5 hours and has a specific patient_id, rx_id and condition


export async function saveMessage(messageBody){
  const patientTag = ` | Patient: ${messageBody.firstName ?? ''} ${messageBody.lastName ?? ''}`;
  try {
      const message = {
          patient_id: messageBody.patientId,
          message_id: messageBody.messageId,
          rx_id: messageBody.rxId,
          condition: messageBody.condition
      };

      console.log(`Saving message: ${JSON.stringify(message)} to recent_messages table${patientTag}`);

      const result = await saveRecord('recent_messages', message);

      if (!result.success) {
          console.error(`Failed to save message:${patientTag}`, result.error);
      }

      return result;

    } catch (error) {
        console.error(`Error in saveMessage:${patientTag}`, error);
        return { success: false, error: error.message };
    }
}


// Query records from a table
async function queryRecords(tableName, filters = {}) {
  try {
    let query = supabase.from(tableName).select('*');
    
    // Apply filters if provided
    Object.entries(filters).forEach(([key, value]) => {
      query = query.eq(key, value);
    });
    
    const { data, error } = await query;
    
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error(`Error querying ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Save a single record
async function saveRecord(tableName, record) {
  try {
    const { data, error } = await supabase
      .from(tableName)
      .insert([record])
      .select();
    
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error(`Error saving to ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Save multiple records
async function saveRecords(tableName, records) {
  try {
    const { data, error } = await supabase
      .from(tableName)
      .insert(records)
      .select();
    
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error(`Error saving records to ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Update a record
async function updateRecord(tableName, id, updates) {
  try {
    const { data, error } = await supabase
      .from(tableName)
      .update(updates)
      .eq('id', id)
      .select();

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error(`Error updating ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// TEMPORARY — first week of launch. Older recent_messages rows predate the
// `condition` column, so we match on message_id instead to catch backed-up
// patients. The "prescription received" text spans two statuses: WaitingforCheck
// (message_id 1, older) and WaitingforPrint (message_id 0, after the switch).
// Lookback is widened to 60 days for the catch-up.
// REVERT after launch to: condition ilike %WaitingforPrint%, 30-day lookback.
// (Keep the rx_id match below when reverting.)
const PRESCRIPTION_RECEIVED_MESSAGE_IDS = [0, 1];
const PRESCRIPTION_RECEIVED_LOOKBACK_DAYS = 60;

// Returns true if the patient was sent the "prescription received" text for THIS
// prescription (rx_id) within the lookback window. Used to gate on-hold campaign
// enrollment so we only remind patients whose prescription was recently received
// — and only for the same Rx that's now going on hold.
export async function hasRecentPrescriptionReceived(patientId, rxId) {
  try {
    const lookback = new Date(
      Date.now() - PRESCRIPTION_RECEIVED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data, error } = await supabase
      .from('recent_messages')
      .select('id')
      .eq('patient_id', patientId)
      .eq('rx_id', rxId)
      .in('message_id', PRESCRIPTION_RECEIVED_MESSAGE_IDS)
      .gte('created_at', lookback)
      .limit(1);

    if (error) {
      console.error('Database error checking recent prescription-received message:', error);
      throw error; // Let caller handle the error
    }

    return data.length > 0;
  } catch (error) {
    console.error('Error checking recent prescription-received message:', error.message);
    throw error; // Re-throw so caller knows something went wrong
  }
}

// Save a patient with an on-hold prescription.
// If the patient already has an ongoing campaign (already in the table), do
// nothing: ignoreDuplicates leaves the existing row and its created_at/TTL
// untouched so a repeat on-hold event doesn't restart or extend the campaign.
export async function saveOnHoldPatient(patientId, phoneNumber, firstName) {
  try {
    const { data, error } = await supabase
      .from('on_hold_patients')
      .upsert(
        {
          patient_id: patientId,
          phone_number: phoneNumber,
          first_name: firstName,
          created_at: new Date().toISOString()
        },
        { onConflict: 'patient_id', ignoreDuplicates: true }
      )
      .select();

    if (error) throw error;
    if (data && data.length > 0) {
      console.log(`Saved on-hold patient: ${patientId}`);
    } else {
      console.log(`On-hold patient already has an ongoing campaign, skipping: ${patientId}`);
    }
    return { success: true, data };
  } catch (error) {
    console.error('Error saving on-hold patient:', error.message);
    return { success: false, error: error.message };
  }
}

// Get templates for an NPI (falls back to default group)
export async function getTemplatesForNpi(npi, firstName, lastName) {
  const patientTag = ` | Patient: ${firstName ?? ''} ${lastName ?? ''}`;
  try {
    let templates = null;

    // If NPI provided, check for group assignment
    if (npi) {
      const { data: assignment, error: assignmentError } = await supabase
        .from('npi_group_assignments')
        .select('group_id')
        .eq('npi', npi)
        .single();

      if (!assignmentError && assignment) {
        // NPI has a group assignment, fetch that group's templates
        const { data: group, error: groupError } = await supabase
          .from('messaging_groups')
          .select('templates')
          .eq('id', assignment.group_id)
          .single();

        if (!groupError && group) {
          templates = group.templates;
          console.log(`Using templates from assigned group for NPI: ${npi}${patientTag}`);
        }
      }
    }

    // Fall back to default group if no assignment or NPI not provided
    if (!templates) {
      const { data: defaultGroup, error: defaultError } = await supabase
        .from('messaging_groups')
        .select('templates')
        .eq('name', 'default')
        .single();

      if (defaultError) {
        console.error(`Error fetching default templates:${patientTag}`, defaultError);
        return null;
      }

      templates = defaultGroup.templates;
      console.log(`Using default templates${patientTag}`);
    }

    return templates;
  } catch (error) {
    console.error(`Error fetching templates for NPI:${patientTag}`, error.message);
    return null;
  }
}