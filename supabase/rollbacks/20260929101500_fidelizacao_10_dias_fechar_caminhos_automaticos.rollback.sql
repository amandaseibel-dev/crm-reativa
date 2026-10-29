-- ROLLBACK de 20260929101500_fidelizacao_10_dias_fechar_caminhos_automaticos.sql
-- Remove so os trechos acrescentados. Rodar isto reabre os dois caminhos.

do $rb$
declare
  v_def text := pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure);
  v_novo text := '
  -- Fidelizacao de 10 dias: dentro do prazo o caso nao e solto por caminho
  -- nenhum. Devolve false (nao levanta excecao) para o lote seguir em frente.
  if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then return false; end if;';
begin
  if position('caso_dentro_prazo_fidelizacao' in v_def) = 0 then
    raise notice 'liberar_fidelizacao_caso ja esta no texto anterior; nada a fazer.';
  else
    if position(v_novo in v_def) = 0 then
      raise exception 'trecho acrescentado nao encontrado em liberar_fidelizacao_caso';
    end if;
    execute replace(v_def, v_novo, '');
  end if;
end $rb$;

do $rb$
declare
  v_def text := pg_get_functiondef('public.nivelamento_automatico_gestao(integer,boolean,text[])'::regprocedure);
  v_novo text := '
     -- Fidelizacao de 10 dias: quem foi acionado ha 10 dias ou menos fica com
     -- o responsavel atual, mesmo que o debito esteja vencido ha mais tempo.
     and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)';
begin
  if position('caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)' in v_def) = 0 then
    raise notice 'nivelamento_automatico_gestao ja esta no texto anterior; nada a fazer.';
  else
    if position(v_novo in v_def) = 0 then
      raise exception 'trecho acrescentado nao encontrado em nivelamento_automatico_gestao';
    end if;
    execute replace(v_def, v_novo, '');
  end if;
end $rb$;
