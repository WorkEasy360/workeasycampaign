import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmsMessageEditor, WhatsAppMessageEditor } from './messaging-editor';

/** SMS and WhatsApp editors (messaging amendment): honest previews, limits, and what the provider will get. */
describe('SMS editor', () => {
  it('shows what the example contact receives, with the STOP instruction and the billed segments', () => {
    const onChange = vi.fn();
    render(<SmsMessageEditor value={{ schema: 'sms.content.v1', text: 'Hi {{ contact.first_name | "there" }}, 20% off' }} disabled={false} errors={{}} onChange={onChange} />);
    expect(screen.getByText(/Hi Alex, 20% off\s+Reply STOP to opt out\./)).toBeInTheDocument();
    expect(screen.getByText(/1 segment \(GSM-7\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Text message'), { target: { value: 'New text' } });
    expect(onChange).toHaveBeenCalledWith({ schema: 'sms.content.v1', text: 'New text' });
  });

  it('shows server findings under the field; an empty draft shows no fake preview', () => {
    render(<SmsMessageEditor value={{ schema: 'sms.content.v1', text: '' }} disabled={false} errors={{ 'messages.0.content.text': ['Write the SMS'] }} onChange={() => {}} />);
    expect(screen.getByText('Write the SMS')).toBeInTheDocument();
    expect(screen.getByText('Write the message to see it here.')).toBeInTheDocument();
    expect(screen.queryByText(/segment/)).toBeNull();
  });
});

describe('WhatsApp editor', () => {
  it('edits the approved template name, language and parameters (with example values)', () => {
    const onChange = vi.fn();
    const value = { schema: 'whatsapp.content.v1' as const, template: { name: 'spring_sale', language: 'en', parameters: ['{{ contact.first_name }}'] } };
    render(<WhatsAppMessageEditor value={value} disabled={false} errors={{}} onChange={onChange} />);
    expect(screen.getByText(/must use a template approved by Meta/)).toBeInTheDocument();
    expect(screen.getByText('Example: Alex')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(onChange).toHaveBeenLastCalledWith({ schema: 'whatsapp.content.v1', template: { ...value.template, parameters: ['{{ contact.first_name }}', ''] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ schema: 'whatsapp.content.v1', template: { ...value.template, parameters: [] } });
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'autumn_offer' } });
    expect(onChange).toHaveBeenLastCalledWith({ schema: 'whatsapp.content.v1', template: { ...value.template, name: 'autumn_offer' } });
  });

  it('read-only drafts cannot be edited', () => {
    render(<WhatsAppMessageEditor value={{ schema: 'whatsapp.content.v1', template: { name: 'x', language: 'en', parameters: ['a'] } }} disabled errors={{}} onChange={() => {}} />);
    expect(screen.getByLabelText('Template name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add parameter' })).toBeDisabled();
  });
});
