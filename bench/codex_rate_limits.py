import json, subprocess, sys, os
def read(home, binary="codex"):
    env=dict(os.environ, CODEX_HOME=home)
    p=subprocess.Popen([binary,"app-server","--stdio","-c",'cli_auth_credentials_store="file"'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,text=True)
    def send(o): p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
    send({"id":1,"method":"initialize","params":{"clientInfo":{"name":"rl","version":"1"}}})
    send({"method":"initialized"})
    send({"id":2,"method":"account/rateLimits/read","params":{}})
    for line in p.stdout:
        m=json.loads(line)
        if m.get("id")==2:
            p.kill(); return m
for home in sys.argv[1:]:
    print(home.split('/')[-1], json.dumps(read(home))[:900])
