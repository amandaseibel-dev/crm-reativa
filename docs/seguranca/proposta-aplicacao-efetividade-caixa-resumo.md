# Aprovação única — indicadores 2026/1 e 2026/2 (PR #966 + PR #965)

Status: PENDENTE DE APROVAÇÃO. Nada foi mesclado, aplicado em produção nem registrado no ledger.

## Composição da entrega

| PR | Branch | Head congelado | Conteúdo |
|---|---|---|---|
| #966 (SQL) | `claude/indicadores-recuperacao-2026-semestres-4ec789` | `1044acfeee423184dcf4e3abecef909676fbb860` | RPC `efetividade_caixa_resumo_semestre`, testes SQL, job de CI, rollback, medição e esta proposta |
| #965 (tela) | `feat/mensalidades-sem-negociacao-indicadores` | `ab37e93b36574707bf719f02ec84eb2830c483f4` | Abas 2026/1 e 2026/2 de Mensalidades sem Negociação, lendo só a RPC acima |

Histórico preservado: nenhum commit foi reescrito ou apagado. A #966 deixou de expor a tela na Efetividade
(`CarteiraEfetividade.jsx` volta ao estado de `origin/main`). A #965 é a única PR que publica indicadores na tela.

Entrega final = #966 (SQL) + #965 (tela). A tela só deve ser mesclada depois da validação do banco.

## Artefatos (SHA-256 integral)

- Migration `supabase/migrations/20261115130000_efetividade_caixa_resumo_semestre.sql`:
  `58a162ed2e0ab13bc9e1bfcd104389df1d54911d57d2e921058bdf83dfb914d0`
- Rollback `docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql`:
  `4bf1b0ffe2dd009809fc929b13ac336cce0d09541f48663f8181c0022fdb88b5`

## Registro M1 (criado só na aprovação, em PR própria, com janela vigente)

Linha de `docs/seguranca/migracoes-aprovadas.tsv`, 6 colunas separadas por TAB:
`ahattpqrjmhkzsmnbdzs` · `20261115130000_efetividade_caixa_resumo_semestre` ·
`58a162ed2e0ab13bc9e1bfcd104389df1d54911d57d2e921058bdf83dfb914d0` ·
`amanda.seibel@aelbra.com.br` · `expira_em` = aprovação + 30 min (UTC) · `pendente`.

## Executor nominal

Amanda Prado Seibel (`amanda.seibel@aelbra.com.br`). A sessão principal executa os passos; nenhum agente aplica migration.

## Sequência (ordem obrigatória)

1. Aprovação desta proposta pela Amanda.
2. Merge da #966 (só SQL; não publica tela).
3. PR de registro M1 com a linha acima; merge.
4. Aplicação do SQL com o hash aprovado, dentro da janela de 30 min.
5. Validação do banco: a função existe com o hash da migration; `has_function_privilege` dá EXECUTE a `authenticated` e não a `anon`;
   o resumo, lido como gestão ativa, devolve os números da tabela abaixo.
6. Merge da #965 (publica a tela). Só depois do passo 5.
7. Validação autenticada: abrir Mensalidades sem Negociação 2026/1 e 2026/2 com conta de gestão ativa e conferir os valores.
8. Ledger: PR que muda o status para `aplicada`, com a versão gerada pelo servidor.

## Rollback

- Banco: `docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql` (`drop function if exists`). Não toca em dados nem na view.
- Frontend: reverter o commit `ab37e93b` na #965 ou não mesclar a #965. Sem a RPC, a aba mostra um aviso neutro e o resto do relatório segue.

## Números (leitura em produção, 15/11/2026; ver `medicao-caixa-resumo-2026-11-15.md`)

Medição feita com SELECTs de leitura. A função da RPC ainda não existe em produção, e o custo por visita
da tela NÃO foi medido. O tempo de 0,5 s refere-se ao SELECT isolado, não ao comportamento da página.

| | 2026/1 | 2026/2 |
|---|---|---|
| Carteira original | R$ 21.710.447,29 (14.979 títulos; fotografia **desatualizada**) | R$ 17.232.872,41 (10.822 títulos) |
| Saldo em aberto | R$ 9.055.032,58 (fotografia) | R$ 16.042.642,07 (inclui R$ 7.232.872,33 em conferência) |
| Negociado | R$ 4.535.961,61 | R$ 1.232.903,01 |
| Caixa confirmado | R$ 535.206,14 (639 pagamentos) | R$ 653.066,80 (594 pagamentos) |
| Pendente de classificação | R$ 3.314.532,12 (1.340) | R$ 120.444,29 (84) |
| % recuperado por caixa | 2,5% | 3,8% |

Os números acima foram lidos do banco. Os testes SQL usam stubs, com valores de teste (carteira 2.100, caixa 100, 4,8%) que não são números de produção.

## Acesso (decisão registrada)

Acesso somente de gestão ativa: e-mail na lista de `usuario_e_gestao()` **e** `usuarios.ativo = true`.
Diretoria não recebe os indicadores. Não há decisão pendente de acesso.
Os relatórios de Mensalidades sem Negociação e a tela de Efetividade seguem a mesma regra da RPC.
A tela de Efetividade continua com o bloco "Em breve" para quem não tem acesso total, como já era.

## Base do denominador de 2026/2

A carteira original de 2026/2 soma todos os títulos do universo, inclusive os cancelados
(`carteira_2026_2_classificar`, 10.822 títulos). O saldo em aberto exclui os cancelados. O percentual
é caixa confirmado ÷ carteira original, com essa base declarada no campo `base_carteira` da RPC.

## Fotografia de 2026/1

A RPC repassa `fotografia_atualizacao_pendente` e `fotografia_gerada_em`. Com `true`, a tela avisa
que carteira, saldo e negociado de 2026/1 podem estar defasados.

## Privilégios

A RPC é restrita a `authenticated`: revoga de `PUBLIC`, `anon` e `service_role`, e do papel
`reativa_responsavel_executor` quando existir. Ver Anexo H em `medicao-caixa-resumo-2026-11-15.md`.

## Registro do version no ledger

Conferência do `version` efetivamente aplicado: ver a seção do `RUNBOOK-MIGRATIONS.md`.
Nada disso é feito antes da aprovação.

## Estado

- Migration e rollback: hashes acima, neste commit.
- Heads e CI/Guardião: obtidos depois do congelamento; sem parecer, nada é liberado.
- Bloqueio conhecido: nenhum no código. Sem aplicação, sem registro e sem merge até a autorização.
