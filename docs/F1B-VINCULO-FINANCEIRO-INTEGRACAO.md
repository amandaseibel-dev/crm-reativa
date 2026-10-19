# F1.b — integração segura do vínculo financeiro (planejamento técnico)

**Estado:** preparação somente no GitHub, sem migration, sem conexão em produção e sem consumidor ativo. A PR #692 contém uma função pura que retorna candidatos, não confirma pagamento.

## Estruturas já existentes
- `solicitacao_confirmacao_pagamentos` associa `confirmacao_id` a `pagamento_id` com unicidade do pagamento, introduzida em `20260922100000_confirmacao_vinculo_pagamentos.sql`.
- `confirmacao_pagamentos_resolver(id)` já separa `VINCULO_GRAVADO`, `CHAVE_MESMA_TRANSACAO`, `AMBIGUO` e `SEM_VINCULO`. Não deve ser substituída por associação por nome e data.
- A função de F1.a `confirmacao_classificar_por_evidencia` devolve a categoria sem gravar status.
- `pagamentos.titulo_numero`, `pagamentos.numero_parcela_completo`, `acordos.numero_ulbra` e `parcelas.boleto` são candidatos a correspondências documentados em `docs/integracoes/prime-mapa-identificadores.md`.
- `ConferenciaPagamentos.jsx` pertence também à PR #673 aberta; não mexer antes de decidir a ordem.

## Contrato da próxima integração
1. A origem deve ser o **pagamento individual** importado, com identidade do aluno já comprovada; não selecionar aluno por nome. O adaptador agora exige `identidadeComprovada === true`, que só pode ser fornecido por uma verificação independente e documentada (nunca pelo `aluno_id` vinculado por nome); até haver esta prova, retorna `IDENTIDADE_NAO_COMPROVADA` e não oferece candidato.
2. Resolver o conjunto de pagamentos da confirmação **pela relação gravada existente**, quando disponível. Para legado sem prova, encaminhar à fila de revisão; não preencher retroativamente por aluno/data/nome.
3. Para cada pagamento, avaliar identificadores explícitos e consistência do acordo, aluno e parcela; qualquer conflito, duplicidade, dado malformado, valor inconsistente ou ausência de prova vai para **revisão manual**, com motivo identificável.
4. Se a prova é apenas número do acordo, o resultado é candidato a **acordo**, sem inferir parcela. Se existe boleto exato, só produzir candidato a parcela depois de comprovar unicidade e titularidade.
5. A análise é **não mutável**: não alterar `pagamentos`, `parcelas`, `acordos`, `solicitacoes_confirmacao_pagamento`, agenda, responsabilidades, baixa, quitação ou estado acadêmico.
6. Na persistência futura, exigir transação atômica, índices únicos, rastreabilidade da evidência e idempotência. **Rateio e pagamentos múltiplos por título exigem especificação/teste própria antes de escrever `titulo_id`.**
7. A classe `BAIXA_CONFIRMADA` não decorre desta correspondência. A prova de caixa vem da fonte oficial documentada, não de `paidAmount` ou presença de `paymentDate` na Prime.

## Critérios de aceite para passar de biblioteca isolada a consumidor
- Testes automatizados da PR #692 aprovados.
- Um teste de integração com dados fictícios usando o schema existente prova correspondência 1:1 e recusa ambiguidades/duplicidades.
- Leitura do estado real da PR #673 e decisão expressa sobre ordem de integração da tela.
- Verificação de unicidade e tipos no schema real (sem consultar ou divulgar dados pessoais).
- Nova autorização da gestão antes de qualquer migration, persistência, deploy ou ativação automática.

**F1.b nesta PR:** somente biblioteca, testes e este contrato. A importação diária e a fila seguem como estão.
