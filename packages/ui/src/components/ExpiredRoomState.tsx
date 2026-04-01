import styles from "./ExpiredRoomState.module.css";

export function ExpiredRoomState() {
  return (
    <section className={styles.panel}>
      <p className={styles.kicker}>innies.live / room unavailable</p>
      <h1 className={styles.title}>room unavailable</h1>
      <p className={styles.copy}>
        This room is no longer available. Create a new room and resend fresh
        agent links.
      </p>
      <a className={styles.action} href="/">
        Create new room
      </a>
    </section>
  );
}
