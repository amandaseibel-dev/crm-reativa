-- Devolve a Saúde da Carteira a calcular `encerrado` só pela regra de status.
-- Atenção: isso traz de volta os 666 casos fantasma (472 cópias duplicadas com
-- gêmeo aberto, R$ 1.306.446,88 contados em dobro) para a contagem E para as
-- listas de "sem acionamento", "críticos" e "urgentes".
do $$
declare
  v_def text; v_novo text;
  v_de  text := '(COALESCE(c.encerrado_operacional, false) OR caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)) AS encerrado';
  v_para text := 'caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada) AS encerrado';
begin
  v_def := pg_get_viewdef('public.vw_saude_carteira'::regclass, true);
  if position(v_de in v_def) = 0 then
    raise exception 'Expressao nova nao encontrada -- a view ja nao esta no estado que este rollback desfaz.';
  end if;
  v_novo := replace(v_def, v_de, v_para);
  execute 'create or replace view public.vw_saude_carteira as ' || v_novo;
end $$;
refresh materialized view concurrently public.mv_saude_carteira;
