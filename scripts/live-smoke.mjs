const SERVER_ORIGIN = "https://arcane-arena-server.drdeandrehyde.workers.dev";
const ROOM = `LIVE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const clients = [];

let latestSnapshot = null;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function waitFor(predicate, timeoutMilliseconds = 6_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) {
        resolve(value);
      } else if (Date.now() - startedAt > timeoutMilliseconds) {
        reject(new Error("Timed out waiting for live arena state."));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
}

async function openClient(name) {
  const endpoint = new URL(`/room/${ROOM}`, SERVER_ORIGIN);
  endpoint.protocol = "wss:";
  endpoint.searchParams.set("name", name);
  const client = {
    id: null,
    name,
    sequence: 0,
    socket: new WebSocket(endpoint),
  };
  clients.push(client);

  client.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "welcome") client.id = message.id;
    if (message.type === "snapshot") latestSnapshot = message;
  });

  await waitFor(() => client.id);
  return client;
}

function player(client) {
  return latestSnapshot?.players.find((candidate) => candidate.id === client.id);
}

function sendInput(client, changes = {}) {
  client.socket.send(
    JSON.stringify({
      type: "input",
      seq: ++client.sequence,
      moveX: 0,
      moveY: 0,
      aimX: 1,
      aimY: 0,
      dash: false,
      primary: false,
      secondary: false,
      utility: false,
      attackHeld: false,
      blockHeld: false,
      feint: false,
      combatDirection: "up",
      ...changes,
    }),
  );
}

async function holdInput(client, changes, durationMilliseconds) {
  const endsAt = Date.now() + durationMilliseconds;
  while (Date.now() < endsAt) {
    sendInput(client, changes);
    await sleep(70);
  }
}

async function holdBoth(
  first,
  firstChanges,
  second,
  secondChanges,
  durationMilliseconds,
) {
  const endsAt = Date.now() + durationMilliseconds;
  while (Date.now() < endsAt) {
    sendInput(first, firstChanges);
    sendInput(second, secondChanges);
    await sleep(70);
  }
}

async function moveTo(client, targetX, targetY, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const current = player(client);
    if (!current) {
      await sleep(30);
      continue;
    }

    const offsetX = targetX - current.x;
    const offsetY = targetY - current.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance < 0.18) {
      sendInput(client);
      return;
    }

    sendInput(client, {
      moveX: offsetX / distance,
      moveY: offsetY / distance,
      aimX: offsetX / distance,
      aimY: offsetY / distance,
    });
    await sleep(70);
  }
  throw new Error(`Movement convergence failed for ${client.name}.`);
}

function facing(from, to) {
  const offsetX = to.x - from.x;
  const offsetY = to.y - from.y;
  const distance = Math.hypot(offsetX, offsetY) || 1;
  return { aimX: offsetX / distance, aimY: offsetY / distance };
}

async function run() {
  const health = await fetch(`${SERVER_ORIGIN}/health`).then((response) =>
    response.json(),
  );
  if (!health.ok) throw new Error("The public arena health check failed.");

  const alpha = await openClient("Live Alpha");
  const beta = await openClient("Live Beta");
  await waitFor(() => latestSnapshot?.players.length === 2);

  await Promise.all([
    moveTo(alpha, 10.35, 2.6),
    moveTo(beta, 21.35, 1.65),
  ]);
  const rendezvous = player(alpha);
  await moveTo(beta, rendezvous.x + 1.7, rendezvous.y - 0.4);
  await sleep(250);

  let alphaState = player(alpha);
  let betaState = player(beta);
  const meleeDistance = Math.hypot(
    alphaState.x - betaState.x,
    alphaState.y - betaState.y,
  );
  if (meleeDistance > 2.39) {
    throw new Error(`Players stopped outside melee range: ${meleeDistance}.`);
  }

  let towardBeta = facing(alphaState, betaState);
  let towardAlpha = facing(betaState, alphaState);

  await holdInput(beta, {
    ...towardAlpha,
    blockHeld: true,
    combatDirection: "left",
  }, 180);
  await holdBoth(
    alpha,
    { ...towardBeta, attackHeld: true, combatDirection: "right" },
    beta,
    { ...towardAlpha, blockHeld: true, combatDirection: "left" },
    430,
  );
  await holdBoth(
    alpha,
    { ...towardBeta, combatDirection: "right" },
    beta,
    { ...towardAlpha, blockHeld: true, combatDirection: "left" },
    430,
  );

  alphaState = player(alpha);
  betaState = player(beta);
  const blockWorked =
    alphaState.combatPhase === "stunned" && betaState.health === 100;
  if (!blockWorked) throw new Error("Directional block smoke failed.");

  await holdBoth(alpha, towardBeta, beta, towardAlpha, 850);
  alphaState = player(alpha);
  betaState = player(beta);
  towardBeta = facing(alphaState, betaState);
  towardAlpha = facing(betaState, alphaState);
  const oppositeAim = {
    aimX: -towardBeta.aimX,
    aimY: -towardBeta.aimY,
  };
  const betaHealthBeforeAimLock = betaState.health;

  await holdInput(alpha, {
    ...towardBeta,
    attackHeld: true,
    combatDirection: "right",
  }, 110);
  await holdInput(alpha, {
    ...oppositeAim,
    attackHeld: true,
    combatDirection: "right",
  }, 330);
  await holdInput(alpha, {
    ...oppositeAim,
    combatDirection: "right",
  }, 450);

  betaState = player(beta);
  const aimLockWorked = betaState.health < betaHealthBeforeAimLock;
  if (!aimLockWorked) throw new Error("Locked attack aim smoke failed.");

  await holdBoth(alpha, towardBeta, beta, towardAlpha, 400);
  alphaState = player(alpha);
  betaState = player(beta);
  towardBeta = facing(alphaState, betaState);
  towardAlpha = facing(betaState, alphaState);
  const healthBeforeTrade = {
    alpha: alphaState.health,
    beta: betaState.health,
  };

  await holdBoth(
    alpha,
    { ...towardBeta, attackHeld: true, combatDirection: "right" },
    beta,
    { ...towardAlpha, attackHeld: true, combatDirection: "left" },
    430,
  );
  await holdBoth(
    alpha,
    { ...towardBeta, combatDirection: "right" },
    beta,
    { ...towardAlpha, combatDirection: "left" },
    430,
  );

  alphaState = player(alpha);
  betaState = player(beta);
  const tradeWorked =
    alphaState.health < healthBeforeTrade.alpha &&
    betaState.health < healthBeforeTrade.beta;
  if (!tradeWorked) {
    throw new Error(
      `Simultaneous trade smoke failed: ${JSON.stringify({
        healthBeforeTrade,
        after: { alpha: alphaState.health, beta: betaState.health },
        phases: {
          alpha: alphaState.combatPhase,
          beta: betaState.combatPhase,
        },
        positions: {
          alpha: { x: alphaState.x, y: alphaState.y },
          beta: { x: betaState.x, y: betaState.y },
        },
      })}`,
    );
  }

  console.log(
    JSON.stringify({
      room: ROOM,
      players: latestSnapshot.players.length,
      tick: latestSnapshot.tick,
      meleeDistance: Number(meleeDistance.toFixed(2)),
      blockWorked,
      aimLockWorked,
      tradeWorked,
      health: { alpha: alphaState.health, beta: betaState.health },
    }),
  );
}

try {
  await run();
} finally {
  for (const client of clients) client.socket.close(1000, "smoke complete");
}
