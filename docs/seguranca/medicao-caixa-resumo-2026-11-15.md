# Medição de caixa e saldo por semestre — 15/11/2026

Leitura somente de consulta (SELECT), no projeto Supabase `ahattpqrjmhkzsmnbdzs`.
Nenhuma função foi criada, nenhum snapshot foi atualizado, nada foi escrito.

## Consultas e resultados

1. Invariante da view de caixa contra `pagamentos`:
   `select count(*), sum(valor_pago) from efetividade_caixa_origem` e o mesmo sobre `pagamentos`.
   Resultado: 11.630 linhas e R$ 14.784.623,69 nos dois lados.

2. Caixa por semestre de origem, critério PROVADA + BAIXADO:
   - 2026/1: 639 pagamentos, R$ 535.206,14; fora do caixa: 1.340 pagamentos, R$ 3.314.532,12.
   - 2026/2: 594 pagamentos, R$ 653.066,80; fora do caixa: 84 pagamentos, R$ 120.444,29.
   - Sem origem determinada (INDETERMINADA): 8.675 pagamentos, R$ 9.908.460,55.

3. Carteira 2026/2 pelo classificador `carteira_2026_2_classificar()`:
   - 10.822 títulos, valor original R$ 17.232.872,41 (bate com `carteira_2026_2_contexto`).
   - Saldo fora de CANCELADO: R$ 16.042.642,07.
   - Conferência R$ 7.232.872,33; acadêmico R$ 111.923,90; sem pendência R$ 8.697.845,84;
     acordos ativos R$ 239.654,71.
   - `carteira_2026_2_negociacoes().total.saldo` = R$ 245.326,06 = acordos ativos
     (R$ 239.654,71) + acordos cancelados (R$ 5.671,35). Não é o saldo total.

4. Fotografia 2026/1 `carteira_efetividade_ler('seis_linhas','2026','1')`: entrou R$ 21.710.447,29;
   em aberto R$ 9.055.032,58; negociado R$ 4.535.961,61; pago por rateio R$ 6.219.804,34.
   Snapshot com `atualizacao_pendente = true`. Os números são antigos e não foram recalculados.

## Limites declarados

- O custo do classificador de 2026/2 em produção não foi medido. A RPC o chama a cada leitura.
- O percentual é caixa confirmado identificado ÷ carteira original. Não é recuperação total.
- Os testes SQL usam stubs de view, classificador e fotografia. Não provam a execução contra
  a view real.
