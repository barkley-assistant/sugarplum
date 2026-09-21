interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Setting name — also the control's accessible name. */
  label: string;
  disabled?: boolean;
}

/** #96: a real toggle switch. The whole row is the control (one Tab stop,
 *  44px touch target, label + track), exactly like the platform settings
 *  rows it replaces — the old role=switch buttons were text rows with an
 *  On/Off word, which is what the issue asked to fix.
 *
 *  `<button role="switch">` keeps the semantics the e2e selectors pin
 *  (role=switch + aria-checked + the label as the accessible name) and gives
 *  Space/Enter for free. The visible track/thumb is aria-hidden decorative
 *  markup; state lives in aria-checked and drives the CSS. */
export function ToggleSwitch({ checked, onChange, label, disabled }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      className="toggle-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-label">{label}</span>
      <span className="switch-track" aria-hidden="true" />
    </button>
  );
}
