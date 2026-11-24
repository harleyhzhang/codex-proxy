import json,glob,os,time,collections,sqlite3
db=sqlite3.connect(os.path.expanduser('~/.codex/state_5.sqlite'))
paths=[r[0] for r in db.execute("select rollout_path from threads where updated_at > strftime('%s','now','-45 days')")]
out=[]; missing=0
for p in paths:
    if not p or not os.path.exists(p): missing+=1; continue
    model=None
    for l in open(p):
        if '"turn_context"' in l:
            try: model=json.loads(l)['payload'].get('model') or model
            except: pass
        elif '"token_count"' in l:
            d=json.loads(l); info=(d['payload'].get('info') or {}); u=info.get('last_token_usage')
            if not u or not model: continue
            out.append({'ts':d['timestamp'],'conv':os.path.basename(p)[-41:-6],'model':model,'in':u.get('input_tokens',0),'cached':u.get('cached_input_tokens',0),'out':u.get('output_tokens',0),'rl':d['payload'].get('rate_limits')})
out.sort(key=lambda r:r['ts'])
json.dump(out,open('bench/demand.json','w'))
c=collections.Counter(); 
for r in out: c[r['model']]+=r['in']-r['cached']+r['cached']*0.1+r['out']*5
print(len(paths),'missing',missing,'events',len(out), out[0]['ts'] if out else '', out[-1]['ts'] if out else '')
for k,v in c.most_common(): print(k, int(v))
