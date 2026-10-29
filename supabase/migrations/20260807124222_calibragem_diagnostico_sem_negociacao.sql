-- Diagnóstico leve para a tela de nivelamento (Calibragem nova): por ano (ou
-- todos), retorna a composição atual "sem negociação" por operador + tamanho do
-- pool (sem responsável) + lista de anos. SÓ LEITURA (não grava rascunho).
-- Gate: gestão. Aplicada em prod via MCP em 2026-08-07.

CREATE OR REPLACE FUNCTION public.calibragem_diagnostico_sem_negociacao(p_ano int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_res jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão.';
  end if;

  with base as (
    select c.operador_email de_email, c.operador_nome de_nome,
           round(coalesce(s.saldo_mensalidade,0),2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where coalesce(s.saldo_mensalidade,0) > 0
      and coalesce(s.saldo_acordo,0) = 0
      and (p_ano is null or extract(year from s.venc_min) = p_ano)
      and not public.caso_protegido_redistribuicao(
            c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
  ),
  ops as (
    select de_email op_email, max(de_nome) op_nome, count(*) qtd, round(sum(valor),2) saldo
    from base where de_email is not null and de_email like 'cobranca%'
    group by de_email
  ),
  anos as (
    select extract(year from s.venc_min)::int ano, count(*) qtd
    from public.casos c join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where coalesce(s.saldo_mensalidade,0)>0 and coalesce(s.saldo_acordo,0)=0 and s.venc_min is not null
    group by 1
  )
  select jsonb_build_object(
    'ano', p_ano,
    'base_total', (select count(*) from base),
    'pool_total', (select count(*) from base where de_email is null),
    'operadores', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by qtd asc),'[]') from ops),
    'anos', (select coalesce(jsonb_agg(jsonb_build_object('ano',ano,'qtd',qtd) order by ano desc),'[]') from anos)
  ) into v_res;
  return v_res;
end; $function$;

REVOKE ALL ON FUNCTION public.calibragem_diagnostico_sem_negociacao(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.calibragem_diagnostico_sem_negociacao(int) TO authenticated, service_role;
