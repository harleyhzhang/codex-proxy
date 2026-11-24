import json, time, sys, os, subprocess, datetime
sys.path.insert(0,'bench')
from codex_rate_limits import read as codex_read
import urllib.request, hashlib
S='/Users/harleyzhang/Library/Application Support/Harley/claude-codex-proxy/'
now=int(time.time())
def iso(s): return int(datetime.datetime.fromisoformat(s).timestamp())
def claude_oauth(cfg):
    h=hashlib.sha256((S+cfg).encode()).hexdigest()[:8]
    raw=subprocess.run(['security','find-generic-password','-s',f'Claude Code-credentials-{h}','-w'],capture_output=True,text=True).stdout.strip()
    tok=json.loads(raw)['claudeAiOauth']['accessToken']
    req=urllib.request.Request('https://api.anthropic.com/api/oauth/usage',headers={'Authorization':'Bearer '+tok,'anthropic-beta':'oauth-2025-04-20','User-Agent':'bench/1.0'})
    try: return json.load(urllib.request.urlopen(req,timeout=15))
    except Exception as e: return None
K_C7, K_C5 = 1.0e-9, 1.17e-8
def claude_acct(cfg, router_file):
    d=claude_oauth(cfg); w=[]; overage=False
    if d:
        for key,mins,k in [('five_hour',300,K_C5),('seven_day',10080,K_C7)]:
            x=d.get(key)
            if x: w.append({'name':key,'used':x['utilization']/100,'resetsAt':iso(x['resets_at']),'minutes':mins,'k':k,'rolling':mins==300})
            elif mins==300: w.append({'name':key,'used':0,'resetsAt':None,'minutes':mins,'k':k,'rolling':True})
        overage=bool((d.get('extra_usage') or {}).get('is_enabled'))
    else:
        r=json.load(open(S+'mixed/'+router_file))
        for key,mins,k in [('five_hour',300,K_C5),('seven_day',10080,K_C7)]:
            x=r.get(key)
            if x and x['resets_at']>now: w.append({'name':key,'used':x['used_percent']/100,'resetsAt':x['resets_at'],'minutes':mins,'k':k,'rolling':mins==300})
            elif x: w.append({'name':key,'used':0,'resetsAt':(x['resets_at']+mins*60) if mins>300 else None,'minutes':mins,'k':k,'rolling':mins==300})
            else: w.append({'name':key,'used':0,'resetsAt':None,'minutes':mins,'k':k,'rolling':True})
        overage = r.get('overage_status')=='allowed'
    return {'windows':w,'overage':overage}
def gpt_acct(home, binary, kweek, kmonth):
    res=codex_read(home, binary)['result']; rl=res['rateLimits']; w=[]
    for n in ('primary','secondary'):
        x=rl.get(n)
        if x and x['windowDurationMins']>360: w.append({'name':'weekly','used':x['usedPercent']/100,'resetsAt':x['resetsAt'],'minutes':x['windowDurationMins'],'k':kweek})
    il=rl.get('individualLimit')
    if il: w.append({'name':'monthly','used':1-il['remainingPercent']/100,'resetsAt':il['resetsAt'],'minutes':43200,'k':kmonth})
    a={'windows':w,'overage':bool((rl.get('credits') or {}).get('hasCredits'))}
    if rl.get('spendControlReached'): a['blocked']='spend limit'; a['blockedUntil']=il['resetsAt'] if il else None
    return a
accounts={
 'claude-personal': claude_acct('claude-config','claude-usage.json'),
 'claude-whop': claude_acct('claude-whop-config','claude-whop-usage.json'),
 'claude-fastwhop': claude_acct('claude-fastwhop-config','claude-fastwhop-usage.json'),
 'gpt-personal': gpt_acct(os.path.expanduser('~/.codex'),'codex',1.1e-9,0),
 'gpt-whop': gpt_acct(S+'codex-whop','/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',2.8e-8,0),
 'gpt-poly': gpt_acct(S+'poly/codex-home','codex',0,3.3e-10),
}
families={
 'opus':[{'slug':'whop-claude-opus-5-5','usage':'claude-whop','tier':'work'},{'slug':'fastwhop-claude-opus-5-5','usage':'claude-fastwhop','tier':'work'},{'slug':'claude-opus-5-5','usage':'claude-personal','tier':'personal'}],
 'sol':[{'slug':'whop-gpt-6.1-sol','usage':'gpt-whop','tier':'work'},{'slug':'poly-gpt-6.1-sol','usage':'gpt-poly','tier':'work'},{'slug':'gpt-6.1-sol','usage':'gpt-personal','tier':'personal'}],
}
demand=[]
for r in json.load(open('bench/demand.json')):
    m=r['model']; tok=r['in']-r['cached']+r['cached']*0.1+r['out']*5
    if 'claude-opus' in m or 'fable' in m:
        fam='opus'; acct={'fastwhop':'fastwhop-claude-opus-5-5','whop':'whop-claude-opus-5-5'}.get(m.split('-')[0],'claude-opus-5-5')
    elif 'gpt-6.1-sol' in m:
        fam='sol'; acct={'whop':'whop-gpt-6.1-sol','poly':'poly-gpt-6.1-sol'}.get(m.split('-')[0],'gpt-6.1-sol')
    else: continue
    demand.append({'ts':iso(r['ts'].replace('Z','+00:00')),'conv':r['conv'],'family':fam,'account':acct,'tokens':tok})
json.dump({'start':now,'days':7,'demand':demand,'accounts':accounts,'families':families},open('bench/bench.json','w'))
for k,v in accounts.items(): print(k, v.get('blocked',''), [(w['name'],round(w['used']*100,1),round(((w['resetsAt'] or now)-now)/3600,1)) for w in v['windows']], 'overage' if v['overage'] else '')
print(len(demand),'demand rows')
