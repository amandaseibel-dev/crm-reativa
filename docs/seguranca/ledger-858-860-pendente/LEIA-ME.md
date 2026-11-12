# Ledger pendente — migrations 858/860, aplicadas em 11/11/2026

As duas migrations de privilégio **já rodaram em produção**. O que falta é só o
**registro no ledger**, e ele está **bloqueado por desenho**. Este diretório
guarda o pacote pronto, fora de `/private/tmp`, para que a conclusão seja um
passo e não uma reconstrução.

## O que já está feito

| Ordem | Arquivo autorizado | Version carimbada | Hora UTC |
|---|---|---|---|
| 1ª | `20261107200000_revoke_truncate_backup_pos_import` | `20261111153032` | 15:30:32 |
| 2ª | `20261108130000_acordos_pos_importacao_sem_truncate` | `20261111170705` | 17:07:05 |

Confirmado em produção, somente leitura: `authenticated` com `TRUNCATE` em
**0** das 548 tabelas `_backup_pos_import_*`; `service_role` preservado nas
548; RLS ligada nas 548 com 0 policy; `EXECUTE` da função inalterado
(`postgres`, `authenticated`, `service_role`). O `status` das duas linhas em
`docs/seguranca/migracoes-aprovadas.tsv` foi para `aplicada`.

## Por que o ledger não foi escrito

O Guardião nega qualquer escrita em `supabase/ledger/**`, pelas duas vias:

- `R5/ledger` no Bash — `plugins/reativa-one/hooks/guardiao.sh:439`
- `P1/ledger` no Edit/Write — `plugins/reativa-one/hooks/guardiao.sh:731`

A alternativa que o próprio hook declara é **"nenhum — ledger não se edita"**.
Não há via sancionada para esta sessão escrever ali, e a restrição **não foi
contornada** — nem por worktree fora do projeto, que é falha conhecida e
registrada, não rota.

## A ação exata que falta

Quem tiver a escrita do ledger liberada executa **três passos**, nesta ordem.

**1. Criar os dois `.sql`, cópia crua dos arquivos autorizados** (byte a byte
iguais aos `statements` de produção — nenhum comentário nosso entra):

```bash
cd /Users/amandapradoseibel/Documents/crm-reativa-atual && cp supabase/aguardando_aprovacao/20261107200000_revoke_truncate_backup_pos_import.sql.pendente supabase/ledger/2026-11/20261111153032__20261107200000_revoke_truncate_backup_pos_import.sql
```

```bash
cd /Users/amandapradoseibel/Documents/crm-reativa-atual && cp supabase/aguardando_aprovacao/20261108130000_acordos_pos_importacao_sem_truncate.sql.pendente supabase/ledger/2026-11/20261111170705__20261108130000_acordos_pos_importacao_sem_truncate.sql
```

**2. Acrescentar as duas linhas de `INDICE-linhas.tsv` (deste diretório) ao
fim de `supabase/ledger/2026-11/INDICE.tsv`.** São 9 campos separados por TAB,
no formato `version · nome · arquivo · md5 · bytes · data_utc · tipo ·
revertida_por · nota`.

**3. Conferir.** O md5 tem de bater com o de produção:

```bash
cd /Users/amandapradoseibel/Documents/crm-reativa-atual && for v in 20261111153032:950affcd2d09891357ec3cdcbd7cef73 20261111170705:4a87a131bde02e15e7713d88b7c70de7; do f=$(ls supabase/ledger/2026-11/${v%%:*}__*.sql); got=$(perl -0pe 's/\n\z//' "$f" | md5 -q); [ "$got" = "${v##*:}" ] && echo "OK  ${v%%:*}  $got" || echo "DIVERGIU  ${v%%:*}  local=$got esperado=${v##*:}"; done
```

## Atenção: estes dois registros quebram a convenção dos anteriores

As entradas de 08/11 e 11/11 do `INDICE.tsv` dizem *"newline final incluso,
usar `md5 -q` direto"*. **Aqui não.** O portão M1 exige o `sha256` do conteúdo
exato **sem** o newline final (`guardiao.sh` usa `printf '%s'`), e foi isso que
produção gravou. Então:

| Version | com `perl -0pe 's/\n\z//'` antes (correto) | `md5 -q` direto (**não** use) |
|---|---|---|
| `20261111153032` | `950affcd2d09891357ec3cdcbd7cef73` | `b4ec4c9792dd25cf2db9cd8cd7fca2c3` |
| `20261111170705` | `4a87a131bde02e15e7713d88b7c70de7` | `e52a857aa58871eff8507c8477be2561` |

Usar o `md5 -q` direto pareceria divergência onde não há. Os `sha256` dos
`statements` são `ea9c49a2…1fa56` e `d2d9cfdc…e9c8a` — **os mesmos** que a
autorização M1 carregava, o que prova que rodou o arquivo aprovado.

Reconferir em produção, somente leitura:

```sql
select version, name,
       md5(array_to_string(statements, E'\n')),
       octet_length(array_to_string(statements, E'\n'))
  from supabase_migrations.schema_migrations
 where version in ('20261111153032', '20261111170705');
```
