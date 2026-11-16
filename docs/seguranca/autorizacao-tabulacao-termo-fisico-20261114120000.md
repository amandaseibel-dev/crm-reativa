# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

**Status: PREPARAÇÃO CONCLUÍDA — IMPLANTAÇÃO BLOQUEADA** por bloqueios externos listados abaixo. Não autoriza execução em produção. Sem linha em `migracoes-aprovadas.tsv`. Linha M1 apenas em rascunho (`docs/seguranca/linha-m1-rascunho-20261114120000.md`), sem validade.

## Decisões registradas (não reabertas)
- **Rollback reversível** (`20261114120000.rollback.sql`): remove somente o que a migração criou (função da trigger, trigger, RPC, tabela `termo_fisico_contencao`, duas linhas do catálogo com marcador `migration_termo_fisico`). Não apaga histórico (`aluno_movimentacoes`) e não altera objeto preexistente. **Recusa com motivo específico (P0001), sem alterar nada,** se houver registros de termo em `aluno_movimentacoes`, alunos com código de termo no estado, catálogo alterado depois da migração, contenção ativa, ou contenção alterada por outro autor (detecção por `alterado_por`). Alternativa operacional quando recusado: ativar a contenção (`contencao_ativa = true`). Validado localmente em PostgreSQL 17 (UTF8): caminho limpo com igualdade de estado antes/depois; recusas por histórico, aluno no estado, catálogo alterado, contenção ativa e contenção alterada, com o rollback passando depois da restauração. ACL de coluna (`attacl`) não é coberta pelo snapshot de propósito: a migração não emite GRANT nem REVOKE de coluna (só de tabela e função, sobre objetos novos; ver `grep -n -i "grant\|revoke"` no .pendente e no rollback), e o rollback não altera ACL de coluna. No CI estão cobertos o caminho limpo, a recusa por histórico e as quatro recusas de `recusas_rollback.sh` (aluno, catálogo, contenção ativa e contenção alterada), com a preservação dos dados comprovada antes da restauração.
- Ativação operacional da contenção (`20261114140000`) foi separada desta entrega: proposta em `proposta/contencao-termo-20261114140000`, não aplicada. Nesta entrega a contenção começa em `false` (registros abertos) e fecha por falha quando ausente ou inválida.
- Gestão: os três e-mails de `usuario_e_gestao()`; sem permissões novas.
- Desfazer do operador com código restrito: recusado inteiro ("Nada foi desfeito").
- Descrição fixa do registro; rótulos aprovados preservados.
- Aba ADM não grava código de registro no estado do aluno (commit `b63a69d6`, preservado).

## Premissa 12 — resolvida no banco
- **Operação** `public.registrar_administrativo_termo_fisico(p_aluno_id, p_codigo)` (na migração `20261114120000`): SECURITY DEFINER, `search_path = public`, EXECUTE só para `authenticated`. Impõe: gestão (`usuario_e_gestao()`), dois códigos, aluno existente, histórico apenas (`REGISTRO_ADMINISTRATIVO`, `registrado_em = now()` do servidor, autor do JWT). Não toca em `alunos`, acionamento, retorno, fidelização, fila nem saldo.
- **Front** (`src/utils/tabulacoes.js`) apenas chama a operação (`rpc`). Não há `insert` direto. Não existe teste dedicado a essa tela nesta #954 (`tabulacoesRegistroAdministrativo.test.js` não existe no repositório).
- **Trigger** `aluno_mov_tabulacao_so_gestao` (INSERT OR UPDATE) mantém a barreira mesmo para gravação direta.

## Trava de tabulação só gestão (`20261106140000`) — fora do escopo desta #954
- Retirada do diff da #954 pelo recorte informativo. Preservada, sem reescrita de histórico, no branch `wip/trava-so-gestao-20261106140000` (commit `8a03e089`).
- A migration desta #954 (`20261114120000`) não chama `_encerramento_so_gestao()` nem objetos de `20261106140000`. O job termo físico não aplica `20261106140000`. O job `tabulacao-so-gestao` (igual à base) continua aplicando a proposta da trava em job próprio; isso não é parte desta #954.

## Auth — confirmação e troca de e-mail
**NÃO VERIFICADO.** As ferramentas desta sessão não expõem a configuração de Auth do projeto (confirmação de e-mail obrigatória, troca de e-mail, origem da identidade). Nenhuma conta ou configuração foi alterada. `usuario_e_gestao()` confia no claim `email` do JWT. **Não tratado como vulnerabilidade comprovada.** Bloqueio externo: leitura da configuração de Auth por quem tem acesso ao painel do projeto.

## Artefatos (SHA-256 integral)
| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `1c81eb7155009f9a8e68cd22404a526c647c83018d58e87bac5eb3f1fe2c2589` | 10313 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `96871b2e876b4a89de5ed6e1661d6ba7484e1ab36148e9b6fd8b5ad002dd75a0` | 6215 |
| `supabase/tests/tabulacao_termo_fisico_gestao/fingerprint_dados_termo.sql` | `6bd0f5a16e4edcba9dc0c172e26a3cd9333bf01077f045f49b2b9f4fc8c804d2` | 1154 |
| `supabase/tests/tabulacao_termo_fisico_gestao/recusas_rollback.sh` | `7bfc35b7ab15412b3116b117c66c03cb6d8295a5b972dc3318926821ae031228` | 2869 |
| `supabase/tests/tabulacao_termo_fisico_gestao/snapshot_termo_fisico.sql` | `7181ce340942ee18c2035c54af6d2b242139a25a0fe34b30024ea8d1ce6f129b` | 1973 |
| `scripts/seguranca/auditoria_seguranca.sql` | `d2a4c33179e9b0a05f63b33469bcbdd3a35c5e108dc587845bce9ac8f7ab0c67` | 5629 |
| `docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` | `cae8f5422b93341fb62debd5e524d10182054ffca7a968cf5b749928ecd3aea9` | 5366 |
| `docs/seguranca/evidencias/prod_usuario_e_gestao.sql` | `83191ea84a90cc0e098d8d33da6179a9c7b6ab4a73c23b2113d4007fbabdb288` | 321 |
| `docs/seguranca/evidencias/prod_schema_rls_grants_movimentacoes_tabulacoes.md` | `cc16b9d3fe38b58b86d842a17835faf131e0c383dc98f174a532f1deca2f4491` | 3944 |

Heads: #954 = o último commit de `feat/termo-fisico-registro-migracao` (ver `git log`); #951 = `ad895092860ef5d24adf6e949371395bc6cbc435`.

Evidências (somente leitura, em 06/11/2026): `usuario_e_gestao()` = `af3d391f4234e6a352585777897568e4`; `_encerramento_so_gestao()` com `md5(pg_get_functiondef) = 5ff3be8222f1f33d6a679be8b313fec5` e `md5(prosrc) = ae0382adc0eaf11fbe68d9ed0fc4a9b4`.

## Gate A — 7 achados BLOQUEIA (abertos, frente responsável)
- `BUCKET_PUBLICO` `tv-imagens` — exceção limitada da TV após revisão do conteúdo público (frente TV). **Não resolvido.**
- `TABELA_SEM_RLS` `_tmp_fila2` — revogação de acesso sem apagar (frente de dados). **Não resolvido.**
- `VIEW_BYPASS_RLS` (5 views): `vw_extracao_calibragem`, `vw_extracao_observabilidade`, `vw_extracao_validacao_trilha`, `vw_pagamento_suspeita_pendente`, `vw_titulo_presenca_historico` — correção com testes dos consumidores (frente de views). **Não resolvido.**
**Não há exceção nem declaração de resolução.** Reexecução do gate depois de tratados.

## Bloqueios externos de implantação (comprovados)
1. Gate A: 7 `BLOQUEIA` abertos (frentes acima).
2. Reconciliação: `usuario_e_gestao()` só como evidência (sem migração versionada), chamada pela migration `20261114120000`; `_encerramento_so_gestao()` fora desta #954 (a versão da trava está no branch preservado).
3. Auth: configuração de confirmação e troca de e-mail (não lida).
4. Papel `reativa_responsavel_executor` (INSERT irrestrito): não lido se é usado com `SET ROLE` por cliente.
5. `tabulacoes` sem DDL base versionado.
6. CI verde no head final (ver abaixo) e parecer do Guardião sem `REPROVADO`.
7. Autorização nominal, executor único, janela M1 publicada só na aprovação.

## Proposta separada — contenção (não aplicada)
- Branch: `proposta/contencao-termo-20261114140000` (commit `427300d7` com os arquivos originais, sem reescrita).
- Arquivos: `supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.sql.pendente` e `.rollback.sql`, além do teste `12p_reaplica.sql`.
- Efeito: liga/desliga `contencao_ativa`. Não é requisito de segurança desta entrega; ativá-la suspende novos registros e torna o rollback de `20261114120000` recusado até decisão da gestão.
- Nesta #954 os testes de preparação (`11p_*`, `12p_on`, `12p_off`) usam atualização direta da flag (mesmo efeito sobre `contencao_ativa`), sem a pré-condição nem a transação da migração.

## Aprovação pendente (não concedida)
- Parecer do Guardião no head final, sem `REPROVADO`.
- CI verde no head final, com as recusas do rollback cobertas por `recusas_rollback.sh`.
- Escopo da contenção (`20261114140000`): separado desta #954 por decisão já encerrada (ver proposta acima). Nada a decidir aqui.
- Autorização nominal, executor único e janela. Nenhuma aplicação em produção e nenhum M1 foram autorizados.
- Rollback reversível validado no CI: caminho limpo, recusa por histórico e as quatro recusas de `recusas_rollback.sh`.

## Sequência de implantação
1. Resolver os bloqueios 1–7.
2. **Banco:** aprovação final → aplicar `20261114120000` (a trava de tabulação só gestão está em `wip/trava-so-gestao-20261106140000`) → validação somente leitura. A guarda `20261114130000` e a prova de sequência/md5 foram retiradas deste recorte.
3. **Frontend (#951):** merge somente após validação do banco.

## Resultados por SHA
- Testes locais (runner reconstruído, sem papel de LOGIN): caminho A e B passam; operação de registro passa; migração da barreira aplica com guarda md5 OK.
- CI e Guardião: ver seção "Resultado" atualizada após a execução.

## Comunicado
Pronto **somente após** publicação e validação. Não é enviado automaticamente.
