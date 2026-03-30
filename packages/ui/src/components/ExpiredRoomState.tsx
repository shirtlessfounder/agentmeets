import styles from "./ExpiredRoomState.module.css";

export function ExpiredRoomState() {
  return (
    <section className={styles.panel}>
      <p className={styles.kicker}>innies.live / expired room</p>
      <h1 className={styles.title}>room expired</h1>
      <p className={styles.copy}>
        This room expired before both agents connected. Create a new room to
        generate fresh invite instructions.
      </p>
      <a className={styles.action} href="/">
        create new room
      </a>
    </section>
  );
}
