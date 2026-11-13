# Pacote de implantação: relatório de mensalidades sem negociação 2026/2

Status: **não aplicado**. Esta PR não executa migration, SQL de escrita, merge nem deploy.

## Artefatos

| Artefato | Caminho | SHA-256 |
|---|---|---|
| Migration | `supabase/migrations/20261113000000_relatorio_2026_2_sem_negociacao.sql` | `567e1a4530f8cceb954d07af93bfbddfb2393363d6b52276f9bf867d0c1fe9cd` |
| Rollback | `supabase/rollbacks/20261113000000_relatorio_2026_2_sem_negociacao.rollback.sql` | `468cbf1d41232beac10fbe52d3e934f376e1d968de2970523d94d0f6a9f49f4c` |

Commit de referência: `7c321818` (PR #947). Conferir o hash do arquivo antes de aplicar.

## Pré-condições

1. Migrations anteriores a `20261113000000` já aplicadas em produção. Não há migration de 2026/2 aplicada hoje.
2. Não há objetos `relatorio_mensalidades_2026_2_*`, `_relatorio_2026_2_eleg` nem a tabela `relatorio_mens_2026_2_snapshot` em produção. Confirmar com leitura antes.
3. Incidente das ações massivas encerrado, ou janela aprovada pela gestão. A migration cria objetos novos e não toca tabelas financeiras; ainda assim, nenhum relatório pesado deve rodar durante o incidente.
4. Backup lógico do schema `public` disponível.

## Ordem de aplicação

1. Conferir o SHA-256 do arquivo versionado contra a tabela acima.
2. Aplicar a migration em **staging** e rodar a validação abaixo.
3. Aprovação explícita da gestão para produção.
4. Aplicar a migration em produção em uma única transação (o arquivo já tem `BEGIN`/`COMMIT`).
5. Só então publicar o frontend (merge da PR, pelo clique humano).

Publicar o frontend antes da migration faz a aba 2026/2 chamar RPCs inexistentes e mostrar erro. A aba 2026/1 não é afetada.

## Validações

- Ler `pg_proc` e confirmar as três funções de 2026/2 com `SECURITY DEFINER` e `search_path` fixo.
- `has_function_privilege` para `anon`: falso nas três funções. Para `authenticated`: verdadeiro nas RPCs e falso no helper.
- `pg_class.relrowsecurity` verdadeiro para `relatorio_mens_2026_2_snapshot`; `authenticated` sem SELECT, INSERT, UPDATE, DELETE ou TRUNCATE.
- Chamada da RPC de leitura com usuário de gestão: retorna `alunos_unicos_semestre`, `cpf_diagnostico` com `alunos_sem_cpf`, e `cpfs_semestre` sem `00000000000`.
- Chamada com usuário comum: erro `42501`.
- Captura: só deve ser feita pela gestão após a aplicação. Não há cron nesta entrega.
- 2026/1: `relatorio_mensalidades_2026_1_sem_negociacao` retorna o mesmo JSON de antes da aplicação (comparar contagens de referência).

## Rollback

O arquivo de rollback só remove os objetos quando a tabela de snapshot está vazia. Se já houve captura, ele aborta sem apagar nada. Isso protege o histórico, mas não reverte a aplicação do frontend.

Para voltar à versão anterior **preservando os snapshots já capturados**, a sequência é:

1. **Reverter o frontend** (revert do merge). A aba 2026/2 deixa de chamar as RPCs. Nenhum dado muda.
2. **Cortar o uso no banco** sem apagar nada:
   - `REVOKE EXECUTE ON FUNCTION public.relatorio_mensalidades_2026_2_sem_negociacao(), public.relatorio_mensalidades_2026_2_capturar() FROM authenticated;`
   - Assim a gestão deixa de executar as funções, e a tabela fica intacta.
3. **Backup do snapshot** antes de qualquer remoção: copiar `relatorio_mens_2026_2_snapshot` para um arquivo ou tabela de backup fora do alcance de `anon`/`authenticated`. Isso é escrita e precisa de autorização específica.
4. **Remover só as funções**, se a gestão decidir: `DROP FUNCTION` das três funções e do helper. A tabela de snapshot permanece com RLS ativa e sem grants.
5. **Remover a tabela** só depois do backup conferido e com autorização explícita, porque é a única cópia do histórico de 2026/2.

Nenhuma dessas etapas é executada nesta PR.

## Riscos residuais

- Estatísticas do planejador desatualizadas: o `EXPLAIN` sem `ANALYZE` estima 1 linha onde a população é de milhares. Os índices são usados, mas vale rodar `ANALYZE` em janela tranquila.
- A regra de CPF (`00000000000` fora da contagem, "Alunos sem CPF" separado) muda a contagem de CPFs em relação à versão anterior da PR. A gestão precisa aprovar esse indicador.
- O 2026/1 tem o mesmo `lpad` que trunca CPFs com mais de 11 dígitos, e isso não foi corrigido nesta entrega, conforme pedido.
