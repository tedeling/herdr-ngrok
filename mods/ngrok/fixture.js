// A test copy of ngrok.yml: one live tunnel, one comment, one off tunnel, and one tunnel with a nested field.
export const FILE = [
  "authtoken: SECRET123", "region: eu", "tunnels:",
  "    api:", "        addr: 8020", "        proto: http", "        hostname: api.example.dev", "        host_header: api.example.dev",
  "    # old port 8000",
  "#herdr-off#    docs:", '#herdr-off#        addr: "localhost:7000"', "#herdr-off#        proto: http", "#herdr-off#        hostname: docs.example.dev",
  "    secure:", "        addr: http://localhost:9000", "        proto: http", "        domain: secure.example.dev", "        basic_auth:", '            - "u:p"',
  'version: "2"', "",
].join("\n");
