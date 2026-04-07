import { createClient } from '@supabase/supabase-js';
const MESSAGE_TYPE_SHIPPING = 3;

// Initialize Supabase client
export async function isDuplicateMessage(messageBody) {
  if(messageBody.messageId === MESSAGE_TYPE_SHIPPING){
    return checkDuplicateShippingMessage(messageBody);
  }
  try {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('recent_messages')
      .select('*')
      .eq('patient_id', messageBody.patientId)
      .eq('message_id', messageBody.messageId)
      .gte('created_at', fiveHoursAgo);
    
    if (error) {
      console.error('Database error checking duplicate:', error);
      throw error; // Let caller handle the error
    }
    
    return data.length > 0; 
    
  } catch (error) {
    console.error('Error checking for duplicate message:', error.message);
    throw error; // Re-throw so caller knows something went wrong
  }
}

export async function checkDuplicateShippingMessage(messageBody){
  try {
    const { data, error } = await supabase
      .from('recent_messages')
      .select('*')
      .eq('patient_id', messageBody.patientId)
      .eq('rx_id', messageBody.rxId)
      .eq('message_id', 3);

    if (error) {
      console.error('Database error checking duplicate:', error);
      throw error; // Let caller handle the error
    }

    if (data.length > 0) {
      console.log('Duplicate shipping message found.');
      return true;
    }

    return false;

  } catch (error) {
    console.error('Error checking for duplicate message:', error.message);
    throw error; // Re-throw so caller knows something went wrong
  }

}
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_API_KEY
  );

//checks if a record exists in the recent_messages table that was created within the last 5 hours and has a specific patient_id and message_id


export async function saveMessage(messageBody){
  try {
      const message = {
          patient_id: messageBody.patientId,
          message_id: messageBody.messageId,
          rx_id: messageBody.rxId
      };

      console.log(`Saving message: ${JSON.stringify(message)} to recent_messages table`);

      const result = await saveRecord('recent_messages', message);
      
      if (!result.success) {
          console.error('Failed to save message:', result.error);
      }
      
      return result;

    } catch (error) {
        console.error('Error in saveMessage:', error);
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

// Save a patient with an on-hold prescription.
// Upsert resets created_at so the 1-month TTL restarts on repeat on-hold events.
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
        { onConflict: 'patient_id' }
      )
      .select();

    if (error) throw error;
    console.log(`Saved on-hold patient: ${patientId}`);
    return { success: true, data };
  } catch (error) {
    console.error('Error saving on-hold patient:', error.message);
    return { success: false, error: error.message };
  }
}

// Remove a patient from the on-hold table (e.g., Podium STOP opt-out)
export async function deleteOnHoldPatient(phoneNumber) {
  try {
    const { data, error } = await supabase
      .from('on_hold_patients')
      .delete()
      .eq('phone_number', phoneNumber)
      .select();

    if (error) throw error;
    console.log(`Deleted on-hold patient with phone: ${phoneNumber}`);
    return { success: true, data };
  } catch (error) {
    console.error('Error deleting on-hold patient:', error.message);
    return { success: false, error: error.message };
  }
}

// Get templates for an NPI (falls back to default group)
export async function getTemplatesForNpi(npi) {
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
          console.log(`Using templates from assigned group for NPI: ${npi}`);
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
        console.error('Error fetching default templates:', defaultError);
        return null;
      }

      templates = defaultGroup.templates;
      console.log('Using default templates');
    }

    return templates;
  } catch (error) {
    console.error('Error fetching templates for NPI:', error.message);
    return null;
  }
}