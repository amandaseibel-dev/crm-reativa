-- Fechamento de Remuneracao: nas linhas da GESTAO (Amanda 3% / Fernanda 1,5%),
-- exibir "quanto foi feito" no mes = base da comissao = total da empresa,
-- em vez de recuperado/honorario zerados. Mudanca SO DE EXIBICAO:
--   - troca 'valor_recuperado'=0 -> v_all_rec, 'honorarios'=0 -> v_all_hon,
--     'qtd_pagamentos'=0 -> v_all_qtd (total de pagamentos do mes).
--   - NAO altera comissao, total_final, nem os totais gerais (t_rec/t_hon
--     continuam somando so a producao dos operadores; a gestao nao entra
--     nesses acumuladores, entao nao ha duplicidade).
-- Feito com replace in-place sobre o fonte atual da funcao (1 ocorrencia unica,
-- validada), evitando reescrever o corpo inteiro.
do $mig$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('public.calcular_fechamento_remuneracao(date)'::regprocedure);
  v_src := replace(
    v_src,
    '''qtd_pagamentos'', 0, ''valor_recuperado'', 0, ''honorarios'', 0,',
    '''qtd_pagamentos'', v_all_qtd, ''valor_recuperado'', v_all_rec, ''honorarios'', v_all_hon,'
  );
  execute v_src;
end
$mig$;
