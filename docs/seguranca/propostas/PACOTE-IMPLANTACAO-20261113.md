# Pacote de implantacao — Acoes Massivas (PR #944, head ab7cffbf)

**Status: PROPOSTA. Nao autorizado. Nada aplicado em producao.** A aprovacao exige decisao expressa da gestao e linhas em `docs/seguranca/migracoes-aprovadas.tsv` (ainda nao registradas).

## 1. Migrations e hashes (sha256 completo, bytes)
| # | Arquivo | sha256 | bytes | Acao |
|---|---|---|---|---|
| 1 | `20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente` | `ad035c52c51dae7fa9baf64efa4c49714328bca954617deadc1c0e1db81b9556` | 4771 | aplicar primeiro |
| 2 | `20261113100000_acoes_massivas_confirmar_envio.sql.pendente` | `627d479bbcb477d75c6e2a34dcb6ecd1a5233c7b6f1138147b58ef4a7c1f6199` | 14570 | aplicar depois de 1 |
| 3 | `20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.sql.pendente` | `f5d6e06a45eae15b2ecbc478e59d43b6c770d301f7d2a57245a361c582ac47b1` | 3324 | aplicar depois de 2 |
| R3 | `...100200...rollback.sql` | `88f5f11cf0a2ed2d38ef551c2b6ce077baa082397abe04a1e25a357ec36af955` | 2942 | reverter primeiro |
| R2 | `...100000...rollback.sql` | `538aa2bfc989d88a0e2b6e1465385214875e5daaa72a50d413023c980ab2d5b2` | 3759 | reverter depois de R3 |
| R1 | `...100100...rollback.sql` | `bcd7a39d639ba4d3c44bca1b03649598a7d1e153c1f6962079c2d28007a12dee` | 4691 | reverter por ultimo |

Md5 de verificacao apos cada etapa (pg_get_functiondef):
- `acoes_massivas_exportar_emails_do_lote`: `00d3370a7800bd334292808e1573a57d` antes; `23664a52cf92257c25a5a837006db582` apos a 1.
- `acoes_massivas_exportar`: `c9cc7498d16ca250e85c4727c8bb05bd` antes; `3861da11bfb0930fc698ce8e1ca05a35` apos a 2.
- `acoes_massivas_concluir_lote`: `3a94002240236f6ccd63296ccc4b6a42` antes (publicado); `57818ede179b6a1cf82a0bdd343f27d3` apos a 3.

## 2. Ordem
- **Aplicar:** 1 → 2 → 3. A 2 recusa se a 1 nao estiver aplicada (guarda de md5); a 3 recusa se a 2 nao estiver.
- **Reverter:** R3 → R2 → R1. Cada rollback recusa se houver lote pendente de qualquer canal (sem filtro de canal) e tem `lock_timeout = 5s` com `LOCK ... SHARE ROW EXCLUSIVE`. R2 recusa se a 3 ainda estiver aplicada.

## 3. Pre-condicoes (todas exigidas antes da janela)
1. Autorizacao expressa da gestao e linhas registradas em `docs/seguranca/migracoes-aprovadas.tsv` com `status` e `expira_em` reais.
2. Backup do banco; PITR nao confirmado: confirmar antes.
3. Pausar novas chamadas (front e chamada direta) de `acoes_massivas_exportar`, `acoes_massivas_exportar_emails_do_lote` e `acoes_massivas_concluir_lote`, conforme `PROCEDIMENTO-REVERSAO-20261113.md`.
4. Zero lotes pendentes de qualquer canal (consulta de contagem por canal, com data e hora).
5. Nenhuma sessao `active` ou `idle in transaction` executando essas funcoes.

## 4. Verificacoes (somente leitura, antes e depois)
- Md5 das tres funcoes conforme a secao 1.
- Efetivo de permissoes (`has_function_privilege`) por papel de `pg_roles`, com PUBLIC pela ACL (`aclexplode`), para exportar, exportar_emails, concluir_lote, concluir_envio e lote_destinatarios. Funcao ausente aparece como ausente.
- `select count(*) from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null` = 0 antes de cada reversao.

## 5. Recuperacao
- Falha na aplicacao: a transacao do arquivo aborta sem alterar nada (BEGIN/COMMIT). Verificar md5 e repetir a janela.
- Falha em rollback por lock: `lock_timeout` aborta a transacao sem alteracao; repetir em nova janela.
- Rollback recusado por lote pendente: nao reverter. Tratar o lote (confirmar por destinatario ou descartar) e repetir.
- Reversao concluida com pendente depois dela: tratar como incidente; registrar e decidir com a gestao.

## 6. Confirmacao parcial (grupo B)
- O fluxo registra somente os destinatarios informados como enviados em `acoes_massivas_concluir_envio` (PARCIAL): o registro usa apenas `v_ids` derivados da lista informada (`20261113100000...sql.pendente`, linhas ~173-182).
- A lista original do lote (`aluno_ids`) nao e alterada (UPDATE em ~196-199 nao toca `aluno_ids`). Nao enviados ficam em `resultado.ids_nao_enviados`.
- Nao ha chamada externa no corpo da funcao: nenhum disparo e feito pela confirmacao.
- A derivacao de e-mail apos PARCIAL usa so `ids_enviados_informados` (`100100` patch 2c). Isso nao comprova envio de e-mail.
- **Ressalva:** no repositorio, "grupo B" nao esta definido no contexto de lotes de acoes massivas (aparece apenas em rotinas Prime). Preciso que a gestao confirme qual conjunto e o grupo B antes de qualquer registro. Nao registrado nesta rodada.

## 7. Fora deste pacote
- Os 247 IDs originais do grupo B estao apenas na pasta restrita da gestao; nao fazem parte desta PR nem do repositorio. A reconciliacao com o relatorio real de envio ainda nao foi feita.
- Nenhuma exportacao, registro de lote ou envio de mensagem foi feito.
- Pendencias de producao nao verificadas: grants de `acoes_massivas_fidelizacao_protege` (anon/public), Edge Functions sem fonte, bucket `tv-imagens`, `_tmp_fila2` sem RLS, views com bypass.
