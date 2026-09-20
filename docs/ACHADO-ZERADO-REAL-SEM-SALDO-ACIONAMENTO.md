# Achado: `ZERADO_REAL_SEM_SALDO` grava `data_ultimo_acionamento`

**Status:** só registro. NÃO corrigido neste PR (#437). Análise separada, a abrir depois da conclusão das Ações Massivas.

## O que foi observado (20/09/2026, leitura em produção)

Ao auditar os 2.371 alunos com `alunos.data_ultimo_acionamento` preenchido e nenhuma movimentação de acionamento válido:

- **2.107** deles têm `data_ultimo_acionamento` exatamente igual (±2 s) ao instante de uma movimentação `ZERADO_REAL_SEM_SALDO` ("Sem saldo em aberto (fonte única): retirado da fila ativa").
- Desses, **59** estão hoje com dívida ativa (o saldo voltou a existir depois).
- O tipo `ZERADO_REAL_SEM_SALDO` tem 6.324 movimentações em 3.556 alunos, de 24/07 a 20/09/2026.
- `eh_tipo_acionamento('ZERADO_REAL_SEM_SALDO')` é falso: então o campo não vem do gatilho `fn_atualizar_ultimo_acionamento`. Alguma rotina de saldo zero escreve o campo diretamente. A origem exata NÃO foi investigada.

Um processo automático de saldo zero não é contato com o aluno. Se ele grava o "último acionamento", o campo deixa de significar "último contato operacional".

## Perguntas para a análise separada

Qual rotina grava o campo e por quê; e qual o impacto sobre:

1. fidelização (`caso_dentro_prazo_fidelizacao`);
2. nivelamento (`nivelamento_automatico_gestao`, `calibragem_simular`);
3. liberação de casos (`casos_elegiveis_liberacao_fidelizacao`, `liberar_casos_fidelizacao_vencida`);
4. data de último contato exibida ao operador;
5. indicadores (Projeção, TV, dashboards) e demais funções que leem `data_ultimo_acionamento`;
6. os 59 alunos que reabriram dívida com esse campo já preenchido (ficam "protegidos" da liberação por até 10 dias).

## Relação com as Ações Massivas

A cobertura das Ações Massivas NÃO usa `data_ultimo_acionamento`: lê `aluno_movimentacoes` com uma lista própria de tipos. Portanto este achado não afeta os números de cobertura e não bloqueia o PR.
