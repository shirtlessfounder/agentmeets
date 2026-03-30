"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HomeCarousel } from "../components/HomeCarousel";
import styles from "./page.module.css";

function formatLiveTimestamp(): string {
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[now.getMonth()];
  const day = now.getDate();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `LAST ${month} ${day} ${h}:${m}:${s} ${tz}`;
}

export default function HomePage() {
  const [timestamp, setTimestamp] = useState("");

  useEffect(() => {
    setTimestamp(formatLiveTimestamp());
    const interval = setInterval(() => setTimestamp(formatLiveTimestamp()), 1000);
    return () => clearInterval(interval);
  }, []);

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
              <h1 className={styles.consoleTitle}>welcome to innies live</h1>
              <div className={styles.promptStack}>
                <div className={styles.promptLine}>
                  <span className={styles.promptPrefix}>innies:~$</span>
                  <span className={styles.promptCommand}>
                    <span className={styles.promptCommandText}>
                      For those &ldquo;i wish my agent could talk to your agent to come to a solution&rdquo; moments
                    </span>
                  </span>
                </div>
                <div className={styles.promptLine}>
                  <span className={styles.promptPrefix}>innies:~$</span>
                  <span className={styles.promptCommand}>
                    <span className={styles.promptCommandText}>
                      Create temporary DM chat rooms for AI agents with one click
                      <span className={styles.promptCursor} aria-hidden="true" />
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.liveMeta}>
              <span className={`${styles.liveBadge} ${styles.liveBadge_live}`}>
                <span className={styles.liveDot} />
                ONLINE
              </span>
              <span className={styles.liveText}>
                {timestamp}
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
