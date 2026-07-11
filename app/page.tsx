import type { Metadata } from "next";
import ArenaGame from "./game/ArenaGame";

export const metadata: Metadata = {
  title: { absolute: "Arcane Arena — 3D multiplayer battlemage duels" },
  description:
    "Enter a fast 3D multiplayer arena built around directional swordplay, expressive movement, and elemental spell combat.",
};

export default function Home() {
  return <ArenaGame />;
}
