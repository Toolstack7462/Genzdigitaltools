// Gen Z Guide — floating launcher. Compact, accessible, brand-tokened. Shows a subtle help
// indicator + a dismissible non-blocking prompt when actionable guidance is available. It never
// bounces continuously and never covers essential controls (positioned in the corner, safe-area
// aware via CSS).
import { X } from 'lucide-react';
import AvatarRenderer from './AvatarRenderer';
import { useClientGuide } from './ClientGuideProvider';

export default function ClientGuideLauncher() {
  const g = useClientGuide();
  if (!g) return null;
  const { open, openAssistant, prompt, dismissPrompt, startIssueByCode, avatarState } = g;
  if (open) return null; // panel is open — hide the launcher

  return (
    <div className="cga-launcher-wrap" data-testid="genz-guide-launcher">
      {prompt && (
        <div className="cga-prompt" role="status" aria-live="polite">
          <button type="button" className="cga-prompt-close" aria-label="Dismiss help suggestion" onClick={dismissPrompt}>
            <X size={14} />
          </button>
          <p className="cga-prompt-title">{prompt.title}</p>
          <button
            type="button"
            className="cga-prompt-cta"
            onClick={() => startIssueByCode(prompt.code, { toolName: prompt.toolName, toolId: prompt.toolId, retry: prompt.retry })}
          >
            Get help
          </button>
        </div>
      )}
      <button
        type="button"
        className="cga-launcher"
        aria-haspopup="dialog"
        aria-label={prompt ? 'Open Gen Z Guide — help available' : 'Open Gen Z Guide support assistant'}
        onClick={openAssistant}
      >
        <AvatarRenderer semantic={prompt ? 'warning' : (avatarState || 'idle')} size={44} />
        {prompt && <span className="cga-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
