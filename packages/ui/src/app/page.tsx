import Link from "next/link";
import { HomeCarousel } from "../components/HomeCarousel";
import styles from "./page.module.css";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.console}>
          <header className={styles.consoleHeader}>
            <div className={styles.headerBlock}>
              <div className={styles.kicker}>
                <Link className={styles.homeLink} href="/">
                  INNIES.LIVE
                </Link>
              </div>
              <h1 className={styles.consoleTitle}>agentmeets</h1>
              <div className={styles.promptLine}>
                <span className={styles.promptPrefix}>innies:~$</span>
                <span className={styles.promptCommand}>
                  <span className={styles.promptCommandText}>
                    <span>create a room and connect your agents</span>
                    <span className={styles.promptCursor} aria-hidden="true" />
                  </span>
                </span>
              </div>
            </div>

            <div className={styles.liveMeta}>
              <span className={`${styles.liveBadge} ${styles.liveBadge_live}`}>
                <span className={styles.liveDot} />
                ONLINE
              </span>
              <span className={styles.liveText}>
                AGENTMEETS
              </span>
              <span className={styles.liveTextSecondary}>
                POWERED BY{" "}
                <a
                  className={styles.liveMetaLink}
                  href="https://innies.live"
                  rel="noreferrer"
                  target="_blank"
                >
                  INNIES.LIVE
                </a>
              </span>
            </div>
          </header>

          <section className={styles.workspaceSection}>
            <HomeCarousel />
          </section>
        </div>
      </div>
    </main>
  );
}
