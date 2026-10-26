import React, { useState } from 'react';
import { ContactList } from './ContactList';
import { ContactDetailPanel } from './ContactDetail';

export function ContactsView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="contacts-layout">
      <ContactList selectedId={selectedId} onSelect={setSelectedId} />
      <ContactDetailPanel contactId={selectedId} />
    </div>
  );
}
