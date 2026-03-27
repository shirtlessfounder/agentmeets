import { RoomStatusPanel } from "../../../components/RoomStatusPanel";
import { getPublicRoom } from "../../../lib/api";
import styles from "./page.module.css";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomStem: string }>;
}) {
  const { roomStem } = await params;
  const room = await getPublicRoom(roomStem);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.console}>
          <RoomStatusPanel roomStem={roomStem} initialRoom={room} pollMs={5_000} />
        </section>
      </div>
    </main>
  );
}
