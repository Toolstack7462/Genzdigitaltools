// Zee — public component for the original Gen Z Digital Store avatar. Thin wrapper over the renderer
// so consumers (via the AvatarRenderer adapter) import a single stable entry. Semantic-only API.
import GenzAvatarRenderer from './GenzAvatarRenderer';
import './genzAvatar.css';

export default function GenzAvatar({ semantic = 'idle', size = 48, lookDirection = null, interactive }) {
  return <GenzAvatarRenderer semantic={semantic} size={size} lookDirection={lookDirection} interactive={interactive} />;
}
