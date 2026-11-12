# Pacote M1 — cadência WhatsApp e receptivo (três migrations)

**Status: NÃO APLICADO em produção.** Aplicação depende de aprovação conjunta.
Mensageria ULBRA é prioridade máxima: nenhuma migration desta cadeia toca objetos da
ULBRA. A janela deve ser escolhida fora da coleta ULBRA em curso (ver memória de 11/11:
429 de taxa e coleta parcial).

## Cadeia e dependências (ordem obrigatória)

| # | PR | Migration | Depende de |
|---|---|---|---|
| 1 | #894 | `20261109120000_whatsapp_continuidade_v2` | — |
| 2 | #910 | `20261111150000_whatsapp_cota_10_operador` | #1 (pré-condição recusa sem a v2) |
| 3 | #923 | `20261112100000_receptivo_log_chave_conversa` | #2 (pré-condição recusa sem a cota 10) |

Cada PR empilha sobre a anterior. Mesclar nesta ordem (clique humano em cada uma).

## Hashes (SHA-256 dos arquivos em `supabase/aguardando_aprovacao/`)

| arquivo | SHA-256 |
|---|---|
| `20261109120000_whatsapp_continuidade_v2.sql.pendente` | `385a835e42aa7c4da4d63d748f07b834ffb66b7490a12273e6f124a7d5d7d386` |
| `20261109120000_whatsapp_continuidade_v2.rollback.sql` | `4edee0c78a10e1c69c46b8f0c533908e4d1da72d02a54e6282df3ef24053c7b8` |
| `20261111150000_whatsapp_cota_10_operador.sql.pendente` | `9739bf9128d3efaea8345a9a42fa3a65765f4f5ba854132aabb956b094dfb864` |
| `20261111150000_whatsapp_cota_10_operador.rollback.sql` | `6723bc29aab059163621546f5bd5a9e86246fcb80ceb041d79595c0f0afdfb78` |
| `20261112100000_receptivo_log_chave_conversa.sql.pendente` | `a83efec69262a5e020ce0cbd1a2ae747cf5384cf3c7afc5819f5ddc595f36205` |
| `20261112100000_receptivo_log_chave_conversa.rollback.sql` | `87f75929fc118087e4e6411302b82605a0ec37fddb0b377002d9e15f36d14b58` |

## Linhas M1 (`docs/seguranca/migracoes-aprovadas.tsv`)

Uma linha por migration, `status` = `pendente` até a aplicação. Expiração e executor
definidos na aprovação. Não gravar antes do merge correspondente.

## Pré-condições (conferidas pela própria migration)

- v2: `whatsapp_config` com parâmetros de continuidade; `resposta_janela_horas` = 24.
- cota 10: v2 aplicada; limites dos canais iguais à fotografia de 11/11 ou a migration recusa;
  `teto_abordagens_operador` = 10 após aplicação.
- chave do log: cota 10 aplicada (função `whatsapp_cadencia_sem_limite_individual` existe).

## Sequência de aplicação

1. Mesclar #894; mesclar #910; mesclar #923 (cada uma com CI verde no head final).
2. Aplicar a v2 (transação; `lock_timeout` não é usado por ela). Conferir. Registrar no ledger.
3. Aplicar a cota 10. Conferir (limites, grants, trigger `trg_whatsapp_cadencia_receptiva`). Registrar.
4. Aplicar a chave do log (transação única, `lock_timeout` 5s). Se o lock não sair em 5s, a
   migration falha inteira e nada muda: repetir em outra janela.
5. Conferências pós-aplicação: índice `uq_receptivo_log_operador_conversa_ciclo` presente;
   `uq_receptivo_log_operador_ciclo` ausente; `conversa_id` preenchido só nas linhas com
   candidato único (NOTICE da migration informa o total); grants da função de registro sem
   `authenticated`.

## Rollback

- v2, cota 10: `.rollback.sql` de cada uma, idempotentes. A cota 10 apaga apenas linhas
  `RECEPTIVA` (derivadas).
- chave do log: ver efeito abaixo.

### Efeito operacional do rollback recusado por duplicidade

Se, depois da chave nova, existir (operador, ciclo) com mais de uma conversa, o rollback da
chave do log **para antes de qualquer mudança** e lista o problema. Nenhuma linha é apagada
automaticamente. A recuperação é:

1. Manter o banco na chave nova (estado correto: os dois atendimentos são legítimos).
2. Listar os grupos duplicados por (operador, ciclo) com as conversas envolvidas.
3. Decidir, caso a caso, com a gestão, se o registro extra deve ser corrigido (por exemplo,
   marcado como revisado), sem excluir o histórico.
4. Só então repetir o rollback, que passa a encontrar só linhas de conversa única.

A consequência de não reverter é apenas a chave nova continuar valendo; nenhum atendimento
é perdido. Os dados são preservados.

## Evidências

- Suite local (Postgres 16.15, instância isolada): `docs/seguranca/receptivo-log-chave/evidencia-suite-local-2026-11-12.log`
  — 19 asserções na migration, 0 falhas; corrida com duas conexões; reprocessamento; rollback recusado com duplicidade e rollback limpo.
- Réplicas de CI locais da cota 10 e da v2: `evidencia-cota10-replica-local.log`, `evidencia-v2-replica-local.log`.
- CI oficial da #910 (head 49336f66, run 43188679382, 19 jobs `success`): ver links no
  relatório de aprovação; inclui os jobs da cota 10 e da v2.
- Prova de que a v2 executada é a do head 13f76862: os 7 arquivos da v2 têm o mesmo blob
  nos dois heads (ver relatório de aprovação).
