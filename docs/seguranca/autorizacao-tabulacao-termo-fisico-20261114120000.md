# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

**Status: PREPARAÇÃO CONCLUÍDA — IMPLANTAÇÃO BLOQUEADA** por bloqueios externos listados abaixo. Não autoriza execução em produção. Sem linha em `migracoes-aprovadas.tsv`. Linha M1 apenas em rascunho (`docs/seguranca/linha-m1-rascunho-20261114120000.md`), sem validade.

## Decisões registradas (não reabertas)
- **Rollback recusa sempre** (SQLSTATE P0001), sem remover objeto nem dado. Reversão = correção para frente, revisada e autorizada separadamente. **Limitação:** este desenho **não cumpre automaticamente** a exigência de rollback do CHECKLIST; o parecer explícito do Guardião é necessário.
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
- A migration desta #954 (`20261114120000`) não chama `_encerramento_so_gestao()` nem objetos de `20261106140000`. O CI não aplica mais `20261106140000`.

## Auth — confirmação e troca de e-mail
**NÃO VERIFICADO.** As ferramentas desta sessão não expõem a configuração de Auth do projeto (confirmação de e-mail obrigatória, troca de e-mail, origem da identidade). Nenhuma conta ou configuração foi alterada. `usuario_e_gestao()` confia no claim `email` do JWT. **Não tratado como vulnerabilidade comprovada.** Bloqueio externo: leitura da configuração de Auth por quem tem acesso ao painel do projeto.

## Artefatos (SHA-256 integral)
| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `5e53b8bf27055e040aec6ab1540c25b8184e549b1bc6cfcb420772378e323302` | 9669 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `e224e6f206471775eb4f45126d11d68393434d6e32b1a867aa61ba1b1f46cfaa` | 776 |
| `scripts/seguranca/auditoria_seguranca.sql` | `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` | 5682 |
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

## Sequência de implantação
1. Resolver os bloqueios 1–7.
2. **Banco:** aprovação final → aplicar `20261114120000` (a trava de tabulação só gestão está em `wip/trava-so-gestao-20261106140000`) → validação somente leitura. A guarda `20261114130000` e a prova de sequência/md5 foram retiradas deste recorte.
3. **Frontend (#951):** merge somente após validação do banco.

## Resultados por SHA
- Testes locais (runner reconstruído, sem papel de LOGIN): caminho A e B passam; operação de registro passa; migração da barreira aplica com guarda md5 OK.
- CI e Guardião: ver seção "Resultado" atualizada após a execução.

## Comunicado
Pronto **somente após** publicação e validação. Não é enviado automaticamente.
