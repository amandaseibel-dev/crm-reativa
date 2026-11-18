# Dependências lidas em produção — carteira_prioridade_bordero

Leitura somente, em 18/11/2026, projeto `ahattpqrjmhkzsmnbdzs`. Nenhuma alteração.

| Objeto | Assinatura | Retorno | Security | Owner | search_path | md5 da definição | ACL |
|---|---|---|---|---|---|---|---|
| `usuario_e_gestao` | `()` | `boolean` | DEFINER | postgres | public | af3d391f4234e6a352585777897568e4 | postgres, authenticated, service_role, reativa_responsavel_executor |
| `aluno_elegibilidade_cobranca` | `(p_aluno_id uuid)` | `elegibilidade_cobranca` | DEFINER | postgres | public | d87c10aac1d733bbf2bdd4683265f3e3 | postgres, service_role (sem authenticated) |

Observações:
- `usuario_e_gestao()` concede gestão por lista fixa de três e-mails no corpo da função.
- `aluno_elegibilidade_cobranca()` não tem EXECUTE para `authenticated`; por isso a RPC nova a chama como definer.
- O corpo completo das duas funções está na leitura de 18/11/2026 (fonte: `pg_get_functiondef`). Reconferir o md5 antes de aplicar a migration.

## Evidências de produção (leitura, 18/11/2026)

- Colunas confirmadas: `casos.operador_email` existe e `casos.responsavel_atual_email` NÃO existe; `alunos.responsavel_atual_email` existe; `aluno_movimentacoes.aluno_id` é text; `solicitacoes_confirmacao_pagamento.aluno_id` é text; `whatsapp_mensagens.timestamp_wa` e `criado_em` são timestamptz; `acoes_massivas_lotes.aluno_ids` é text[].
- Fuso: fuso da sessão do servidor = UTC; `importacoes.created_at` é timestamp sem fuso com default `now()`.
- Default de privilégio para funções criadas por `postgres` em `public`: EXECUTE para authenticated e service_role (não para PUBLIC, anon ou `reativa_responsavel_executor`). A migration revoga service_role e reativa_responsavel_executor e concede só a authenticated.
- Escopo de titularidade: 9 casos ativos divergem entre `casos.operador_email` e `alunos.responsavel_atual_email`. A autorização usa a chave da tela (`alunos.responsavel_atual_email`).
- Carga medida (somente leitura): elegibilidade canônica de 500 alunos com casos ativos, cerca de 9 ms de execução. A função de prioridade completa ainda não está em produção, então não há medida dela.

## Exceção registrada à PREMISSAS §12

A ordem da lista visível (Fila inteligente) continua calculada no cliente, a partir do booleano `prioridade` devolvido pelo banco. As regras de quem é prioridade, quem é excluído e de que população fazem parte são calculadas no banco. Motivo: a lista já vem filtrada pelo escopo autorizado; mover a ordenação para o SQL mudaria a paginação da tela sem ganho de segurança. Aprovação exigida: gestão, por escrito, na PR.

## Pendências conhecidas (não bloqueiam a prioridade, mas ficam explícitas)

- `lote_pendente` não exclui nada hoje: não há lote pendente em produção (0), porque a exportação confirma no envio. Só passa a valer com a #944.
- Grupo B: sem referência no CRM. Nenhum aluno do grupo B é excluído automaticamente.
- Acionado hoje: a revalidação antes de abrir a ficha continua usando a regra existente (`candidatoSegueValido`); a prioridade não usa janela de contato recente.
- Escopo de `usuario_e_gestao()`: inclui a cobranca07, cujo perfil é administrativo. Decisão de gestão, já registrada como pendência.

## Consulta de colunas em produção (somente leitura, 18/11/2026)

Resultado de `information_schema.columns` para as colunas usadas pela migration (fuso da sessão: UTC):

| tabela | coluna | tipo | default |
|---|---|---|---|
| importacoes | created_at | timestamp sem fuso | now() |
| importacoes | tipo | text | — |
| acordos_titulos | aluno_id | uuid | — |
| acordos_titulos | importacao_id | uuid | — |
| acordos_titulos | situacao | text | — |
| acordos_titulos | vencimento | date | — |
| acordos_titulos | valor_em_aberto | numeric | — |
| acordos_titulos | saldo_corrigido | numeric | — |
| aluno_movimentacoes | registrado_em | timestamptz | now() |
| aluno_movimentacoes | tipo | text | — |
| alunos | responsavel_atual_email | text | — |
| whatsapp_conversas | aluno_id | uuid | — |
| whatsapp_mensagens | conversa_id | uuid | — |
| whatsapp_mensagens | direcao | text | — |
| whatsapp_mensagens | status | text | — |
| whatsapp_mensagens | timestamp_wa | timestamptz | — |
| solicitacoes_confirmacao_pagamento | status | text | 'AGUARDANDO_CONFIRMACAO' |
| acoes_massivas_lotes | confirmado_em | timestamptz | — |
| acoes_massivas_lotes | descartado_em | timestamptz | — |
| usuarios | ativo | boolean | true |

Cobertura: somente as colunas listadas acima (as referenciadas pela migration). Não é inventário completo do banco.
Consulta de `casos.responsavel_atual_email` não existe em produção; a titularidade usa `alunos.responsavel_atual_email`.

## Escopo de gestão (decisão desta PR, fundamentada na PREMISSA_SEGURANCA §2)

- Escopo amplo da RPC: somente `amanda.seibel@aelbra.com.br` (gestora total, §2).
- `usuario_e_gestao()` inclui também cobranca04 e cobranca07, que §2 não trata como gestão total. Para eles a RPC devolve somente a própria carteira.
- Efeito: Fernanda (cobranca04) e Amanda ADM (cobranca07) veem prioridade e guiado apenas da própria carteira. Se o escopo de cada um precisar ser ampliado, a PREMISSA §2 deve definir a regra antes.
