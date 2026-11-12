const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readGroupDirectory } = require("../src/groupDirectory");
const whatsapp = require("../src/whatsappClient");

function setup(window) {
  const events = [];
  const logger = { info: (...args) => events.push(args), warn() {} };
  let libraryCalls = 0;
  const client = {
    pupPage: { async evaluate(fn) {
      return JSON.parse(JSON.stringify(vm.runInNewContext(`(${fn.toString()})()`, { window })));
    } },
    async getChats() { libraryCalls++; throw new Error("r"); },
  };
  return { client, logger, events, libraryCalls: () => libraryCalls };
}

test("current WhatsApp collection lists groups despite broken getChats and absent Store", async () => {
  const broken = { get id() { throw new Error("unreadable unrelated chat"); } };
  const models = [
    { id: { _serialized: "100@g.us" }, name: "Leave Planning", serialize() { throw new Error("r"); } },
    { id: { $1: "200@g.us" }, formattedTitle: "Sales" },
    { id: { user: "300", server: "g.us" }, groupMetadata: { subject: "Staff" } },
    { id: { _serialized: "400@c.us" }, name: "Private contact" },
    broken,
  ];
  const s = setup({ require(name) { assert.equal(name, "WAWebCollections"); return { Chat: { getModelsArray: () => models } }; } });
  const groups = await readGroupDirectory(s.client, s.logger);
  assert.deepEqual(groups.map(g => [g.id._serialized, g.name]), [["100@g.us", "Leave Planning"], ["200@g.us", "Sales"], ["300@g.us", "Staff"]]);
  assert.equal(s.libraryCalls(), 0);
  assert.deepEqual(s.events[0][0], { groupCount: 3, leavePlanningMatches: 1 });
});

test("older Store-only clients and duplicate group models remain supported", async () => {
  const chat = { id: { _serialized: "100@g.us" }, name: "Leave Planning" };
  const s = setup({ require() { throw new Error("module unavailable"); }, Store: { Chat: { getModelsArray: () => [chat, chat] } } });
  assert.equal((await readGroupDirectory(s.client, s.logger)).length, 1);
});

test("a genuinely empty directory is distinct from lookup failure", async () => {
  const s = setup({ require: () => ({ Chat: { getModelsArray: () => [] } }) });
  assert.deepEqual(await readGroupDirectory(s.client, s.logger), []);
  assert.equal(s.libraryCalls(), 0);
});

test("library fallback works when the raw collection cannot be read", async () => {
  const s = setup({});
  s.client.getChats = async () => [{ id: { _serialized: "100@g.us" }, isGroup: true, name: "Leave Planning" }];
  assert.equal((await readGroupDirectory(s.client, s.logger))[0].name, "Leave Planning");
});

test("both lookup failures surface an error instead of a false empty group list", async () => {
  const s = setup({});
  await assert.rejects(readGroupDirectory(s.client, s.logger), error => error.statusCode === 503);
});

test("the public group API uses the compatible directory and returns sorted options", async () => {
  const s = setup({ require: () => ({ Chat: { getModelsArray: () => [
    { id: { $1: "200@g.us" }, name: "Sales" },
    { id: { _serialized: "100@g.us" }, name: "Leave Planning" },
  ] } }) });
  whatsapp._internal.__setTestClient(s.client, whatsapp._STATUS.READY);
  assert.deepEqual(await whatsapp.listGroups(), [
    { id: "100@g.us", name: "Leave Planning" }, { id: "200@g.us", name: "Sales" },
  ]);
  assert.equal(s.libraryCalls(), 0);
});
