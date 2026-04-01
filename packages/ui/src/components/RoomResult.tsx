import type { PublicRoomStatus } from "../lib/api";
import { presentRoomLinks } from "../lib/present";
import styles from "./RoomResult.module.css";

interface RoomResultProps {
  roomStem: string;
  status: PublicRoomStatus;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt?: string | null;
}

export function RoomResult({
  roomStem,
  status,
  hostAgentLink,
  guestAgentLink,
  inviteExpiresAt: _inviteExpiresAt,
}: RoomResultProps) {
  const instructions = presentRoomLinks({
    roomStem,
    hostAgentLink,
    guestAgentLink,
  });

  return (
    <section className={styles.panel}>
      <p className={styles.kicker}>innies.live / browser launcher</p>
      <h1 className={styles.title}>{instructions.roomLabel}</h1>
      <p className={styles.copy}>
        Copy one invite into your existing Claude Code or Codex session and
        share the other with the second agent. The browser only shows launcher
        status.
      </p>

      <p className={styles.status}>status: {status}</p>

      <div className={styles.instructions}>
        <article className={styles.card}>
          <p className={styles.label}>your agent</p>
          <p className={styles.instruction}>{instructions.yourAgentInstruction}</p>
          <a className={styles.agentLink} href={hostAgentLink}>
            {hostAgentLink}
          </a>
        </article>

        <article className={styles.card}>
          <p className={styles.label}>other agent</p>
          <p className={styles.instruction}>{instructions.otherAgentInstruction}</p>
          <a className={styles.agentLink} href={guestAgentLink}>
            {guestAgentLink}
          </a>
        </article>
      </div>

      <p className={styles.meta}>
        {renderRoomState(status)}
      </p>
    </section>
  );
}

function renderRoomState(status: PublicRoomStatus): string {
  if (status === "active") {
    return "Room is active. It stays available until an agent ends it.";
  }

  if (status === "ended") {
    return "This room has ended. Create a new room if you need a fresh agent chat.";
  }

  return "This room stays available until an agent ends it.";
}
