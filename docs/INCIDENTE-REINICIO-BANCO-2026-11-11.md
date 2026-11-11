# Incidente — CRM indisponível por 6 minutos, reinício do banco (11/11/2026)

Projeto Supabase de produção: `ahattpqrjmhkzsmnbdzs` (us-west-2, Postgres
17.6.1.127). Todos os horários em BRT (UTC−3). Tudo abaixo foi medido por
leitura; nada foi alterado em produção durante o diagnóstico.

## Resumo

O CRM ficou indisponível para a operação **das 14:31 às 14:37** — seis
minutos. O banco reiniciou às **14:37:42** e recuperou em cerca de dois
segundos; o serviço voltou ao normal a partir daí. **A causa do reinício não
está provada.**

O ponto que mais importa para quem ler isto depois: durante quatro minutos o
Postgres **não escreveu uma linha de log** enquanto o tráfego estava no chão.
Um banco que não loga nada nesse intervalo não está lento — está parado.

## Linha do tempo (confirmada)

| horário | evento | fonte |
|---|---|---|
| 14:18:20 | consulta de **31,9 s** | `postgres_logs`, `duration: 31951.739 ms` |
| 14:25–14:30 | checkpoints escrevendo por **121 a 171 s** cada | `checkpoint complete: ... write=171.340 s` |
| 14:30:13 | `tv_snapshot_atualizar()` leva **13,0 s** (normal: 3–9 s) | cron 85 |
| 14:30:17–14:30:20 | rajada de `permission denied` (sessões perdendo token) | `postgres_logs` |
| **14:30:20 → 14:33:00** | **silêncio total no log do Postgres** | `postgres_logs` |
| 14:33:00 | um único `canceling statement due to statement timeout` | `postgres_logs` |
| **14:33:00 → 14:37:43** | **silêncio total no log do Postgres** (4 min 43 s) | `postgres_logs` |
| 14:37:42.9 | `pg_postmaster_start_time()` — o processo subiu | `pg_postmaster_start_time()` |
| 14:37:43.0 | `the database system is starting up` (×5) | `postgres_logs`, FATAL |
| 14:37:43.4 | `the database system is not accepting connections` (×7) | `postgres_logs`, FATAL |
| 14:37:45.0 | `pg_cron scheduler started` — recuperado | `postgres_logs` |

### A indisponibilidade, medida pelo tráfego

Requisições por minuto (`edge_logs`):

```
14:23  624    14:29  201    14:35   44  ←
14:24  639    14:30  475    14:36   48  ←
14:25  889    14:31   47  ←  14:37  517
14:26  304    14:32   19  ←  14:38  576
14:27  126    14:33   24  ←  14:39  442
14:28  298    14:34   51  ←  14:40  311
```

De 475–889 req/min para **19–51 req/min durante seis minutos**, voltando a
517+ assim que o banco subiu. É esta a janela de indisponibilidade.

## O que está confirmado

1. O banco reiniciou às 14:37:42 e recuperou em ~2 s.
2. O tráfego esteve no chão das 14:31 às 14:36.
3. O log do Postgres fica mudo das 14:30:20 às 14:37:43, com uma única linha
   no meio.
4. **Não há `PANIC`, não há `out of memory`, não há `terminating connection
   due to administrator command`** em nenhum momento das 24 h.
5. Foi **um único reinício em 24 h**.
6. Nas horas anteriores havia pressão de I/O real: checkpoints de 2 a 3
   minutos e uma consulta de 31,9 s.
7. Depois do reinício: zero `ERROR`, zero `FATAL`, 34/60 conexões, 0 bloqueios,
   cache 99,44%, projeto `ACTIVE_HEALTHY`, nenhum alerta de saúde.

## O que é hipótese

- **Travamento no nível do host** (CPU, I/O ou memória fora da visão do
  Postgres), seguido de reinício pelo *health check* da plataforma. Os
  checkpoints de 121–171 s e o silêncio no log apontam para I/O, mas não
  fecham.
- **Reinício ordenado pela Supabase** (manutenção, redimensionamento,
  migração de host).

Nenhuma das duas foi comprovada. O registro que decidiria está na
infraestrutura da Supabase, fora do alcance das ferramentas usadas aqui.

## O que NÃO explica o incidente

A PR #912 reduz pela metade as requisições da Minha Carteira em
`aluno_movimentacoes`. **Isso é uma melhoria de carga, não a correção da causa
da queda.** Reduzir requisição diminui a pressão que precede o evento; não
prova que o evento não volta. Enquanto a causa do reinício não for
identificada pela Supabase, o risco continua aberto.

---

# Relato para o suporte Supabase

**Assunto:** Postgres restart with ~6 minutes of unavailability on
2026-11-11, no PANIC/OOM in logs — need infrastructure event

**Project ref:** `ahattpqrjmhkzsmnbdzs` (us-west-2, Postgres 17.6.1.127)

**What happened.** On 2026-11-11 our production database became unresponsive
for roughly six minutes and then restarted. We need to know what triggered the
restart, because nothing in the Postgres logs explains it.

**Timeline (UTC):**

- `17:18:20` — a query logged `duration: 31951.739 ms`
- `17:25`–`17:30` — checkpoints completing with `write=121.595 s`,
  `write=155.782 s`, `write=171.340 s`
- `17:30:13` — `SELECT public.tv_snapshot_atualizar()` took 13.0 s (normally
  3–9 s)
- `17:30:20` → `17:33:00` — **no Postgres log output at all**
- `17:33:00` — one `canceling statement due to statement timeout`
- `17:33:00` → `17:37:43` — **no Postgres log output at all (4m43s)**
- `17:37:42.908` — `pg_postmaster_start_time()`; the postmaster started
- `17:37:43` — `the database system is starting up` (FATAL ×5), then
  `the database system is not accepting connections` (FATAL ×7)
- `17:37:45.009` — `pg_cron scheduler started`; recovery complete

**Request volume** (from our edge logs, requests/minute) dropped from 475–889
to 19–51 between `17:31` and `17:36`, returning to 517+ at `17:37`.

**What we checked and did not find:** no `PANIC`, no `out of memory`, no
`terminating connection due to administrator command`, no
`database system was interrupted` — across the full 24-hour window. Only one
restart in 24 hours. `get_advisors(health)` returns no lints and the project
reports `ACTIVE_HEALTHY`.

**What we are asking:**

1. Was this restart initiated by Supabase (maintenance, resize, host
   migration, health-check action)? If so, at what time and why?
2. If it was not initiated by Supabase, do your host-level metrics show CPU
   steal, I/O stall, or memory pressure on this instance between 17:30 and
   17:38 UTC?
3. Were the OOM killer or any host watchdog involved? A kill at the container
   level would leave no trace in the Postgres log, which matches what we see.
4. The checkpoint write times of 121–171 seconds in the preceding minutes —
   are they consistent with degraded disk throughput on this instance?
5. What is the current compute size and disk throughput limit for this
   project, and were we hitting either of them?

**Context.** This instance runs with `max_connections = 60`. We have an
unrelated application-side change in review that halves one screen's request
volume, but we are treating that as load reduction, not as a fix for this
incident.
