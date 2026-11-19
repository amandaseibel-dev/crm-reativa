# Pacote de implantacao — Acoes Massivas (PR #944)

**Status: PROPOSTA. Nao autorizado. Nada aplicado em producao.** A aprovacao exige decisao expressa da gestao e linhas em `docs/seguranca/migracoes-aprovadas.tsv` (ainda nao registradas).

## 1. Migrations e hashes (sha256 completo, bytes)
| # | Arquivo | sha256 | bytes | Acao |
|---|---|---|---|---|
| 1 | `20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente` | `4fcce722aebc637b3f9ae86777aeb1a3695ca305d0e9f0b013beb07b5d6f8980` | 4708 | aplicar primeiro |
| 2 | `20261113100000_acoes_massivas_confirmar_envio.sql.pendente` | `627d479bbcb477d75c6e2a34dcb6ecd1a5233c7b6f1138147b58ef4a7c1f6199` | 14570 | aplicar depois de 1 |
| 3 | `20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.sql.pendente` | `e810afa98e3bf827284370f401b01154d6bf3d8cc8778d17a86acab50a56ca49` | 4021 | aplicar depois de 2 |
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

## 6. Confirmacao parcial e lista de envios anteriores
- O fluxo registra somente os destinatarios informados como enviados em `acoes_massivas_concluir_envio` (PARCIAL): o registro usa apenas `v_ids` derivados da lista informada (`20261113100000...sql.pendente`, linhas ~173-182).
- A lista original do lote (`aluno_ids`) nao e alterada (UPDATE em ~196-199 nao toca `aluno_ids`). Nao enviados ficam em `resultado.ids_nao_enviados`.
- Nao ha chamada externa no corpo da funcao: nenhum disparo e feito pela confirmacao.
- A derivacao de e-mail apos PARCIAL usa so `ids_enviados_informados` (`100100` patch 2c). Isso nao comprova envio de e-mail.
- **Ressalva:** a lista de 247 destinatarios de envios anteriores nao esta no repositorio e nao e um lote desta PR. Nao e registrada por esta PR. A reconciliacao feita ate aqui esta na secao 8.

## 7. Fora deste pacote
- Os 247 IDs da lista de envios anteriores estao apenas na pasta restrita da gestao; nao fazem parte desta PR nem do repositorio. Esta PR nao suporta registrar esse historico (ver secao 8).
- Nenhuma exportacao, registro de lote ou envio de mensagem foi feito.
- Controles de producao NAO verificados (ver secao 10).

## 8. Reconciliacao de envios anteriores (somente leitura, sem dado pessoal)
Fonte: lista de 247 destinatarios preparada em 17/11/2026 (pasta restrita, fora do repositorio), comparada por leitura com o CRM e com o relatorio de campanha. Nenhum lote foi criado, nenhum acionamento foi registrado e nenhuma mensagem foi enviada.

- 247 destinatarios na lista.
- 11 inalcancaveis (3 sem cadastro e 8 com dado invalido).
- 236 cadastrados. A contagem inclui cadastros fora do alcance de quem consultou.
- 218 com envio no relatorio da campanha "Reativa tarde" (0 falhas no relatorio).
- 18 cadastrados sem envio no relatorio. **Causa nao verificada.** Hipoteses a testar: lista de bloqueio ou atendimento ativo. Amostra verificada: 4 de 20.
- Limite: nao ha relatorio de envio que bata com os 247 como lista unica. A comparacao depende de telefone normalizado e identificador da mensagem, sem exigir aluno_id do provedor.

**Consequencia para esta PR:** o registro historico desses envios nao e suportado. Qualquer registro desse conjunto exige funcao propria, aprovada em separado. Nao ha funcao historica nesta PR.

## 9. Dados pessoais e aceite
- A RPC `acoes_massivas_lote_destinatarios` (migration `20261113100000`, restrita a gestao por `usuario_e_gestao`) exibe **nome completo em claro** a gestao. Telefone e e-mail sao mascarados.
- Aceite: decisao da gestora registrada na conversa de revisao da PR ("Nome: mantenha completo nessa tela, restrita aos usuarios autorizados"). **Nao ha aceite formal em documento** de outra pessoa; registrar formalmente antes da aprovacao, se a gestao exigir.
- Enquanto o nome estiver em claro, o item "Dados pessoais mascarados" do §13 **permanece desmarcado**.

## 10. Bloco §13 (docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md) e controles nao verificados
- Segurança validada: **nao marcado** (leitura do SQL; sem teste de perfil em producao).
- Perfis testados: **parcial**. O CI cobre "Acesso negado" (`supabase/tests/acoes_massivas_confirmar_envio.test.js`). anon, authenticated sem perfil, operador, Fernanda e Amanda ADM: **NAO CONFERIDO**.
- RLS validada: **NAO CONFERIDO** (nenhuma migration da rodada altera RLS ou policy; producao nao reconferida).
- Grants validados: **nao marcado**. REVOKE/GRANT em `20261113100000`; efeito testado so em PostgreSQL descartavel no CI; producao **NAO CONFERIDO**.
- RPCs validadas: **nao marcado**. Gate `usuario_e_gestao` e `search_path` fixo na funcao. Producao **NAO CONFERIDO**.
- Dados pessoais mascarados: **nao marcado** (nome em claro para a gestao; secao 9).
- Arquivos privados: n/a (nenhum storage ou bucket na rodada).
- Alteracoes operacionais inesperadas: 0 (nada executado em banco ou producao nesta auditoria).
- Rollback preparado: **marcado** (tres rollbacks, testados em PGlite e em PostgreSQL descartavel no CI).

Pendencias de producao nao verificadas, sem aceite: grants de `acoes_massivas_fidelizacao_protege` (anon/public), Edge Functions sem fonte (`exportar-gestao`, `prime-buscar-nome`, `prime-titular`, `prime-extrato`, `prime-acordo`), bucket `tv-imagens` publico, `_tmp_fila2` sem RLS, views com bypass.
