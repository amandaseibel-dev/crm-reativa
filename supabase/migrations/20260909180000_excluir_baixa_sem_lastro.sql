-- EXCLUIR A BAIXA QUE NENHUM PAGAMENTO SUSTENTA.
--
-- REGRA DA AMANDA: se o titulo nao esta liquidado no Prime, nao pode estar
-- baixado aqui. E o sistema faz sozinho -- nada manual.
--
-- O RECORTE, medido em 09/09. Das 3.114 parcelas pagas com boleto de 11
-- digitos, 467 nao tinham pagamento NENHUM do acordo. Elas se separam por quem
-- baixou:
--   324  amanda.seibel  -- baixas legitimas dela, dinheiro que entrou por fora
--                          do relatorio. NAO SE TOCA. Confirmado por ela.
--     8  cobranca04     -- idem.
--   135  ninguem        -- R$ 123.182,81. Baixa sem pagamento e sem ninguem
--                          assumindo. E ESTA que sai.
--
-- O valor bate com o que dois caminhos independentes ja tinham achado na mesma
-- investigacao: R$ 123.182,81. E os 53 acordos que reabrem sao exatamente os
-- "53 acordos quitados sem lastro" que ja estavam na lista dela.
--
-- ARMADILHA: baixa manual e "quitar e encerrar" NAO geram linha em pagamentos.
-- Entao "sem pagamento" NAO e sinonimo de "sem lastro". O discriminador e
-- parcelas.confirmado_por_email -- quem assinou.
--
-- CONSEQUENCIA REAL: 53 acordos hoje QUITADOS voltam a ATIVO e os alunos voltam
-- para a fila. Correto: nunca foram pagos.

create or replace function public.crm_pode_desfazer_baixa()
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if session_user in ('postgres','supabase_admin') then return true; end if;
  return coalesce(public.crm_usuario_pode_quitar_baixar(), false);
exception when others then return false;
end $$;

comment on function public.crm_pode_desfazer_baixa() is
  'Portao do estorno: a rotina do sistema passa, o resto continua exigindo gestao financeira.';

do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.desfazer_baixa_parcela(uuid)'::regprocedure);
  if position('crm_pode_desfazer_baixa' in d) = 0 then
    d := replace(d,
      'if not public.crm_usuario_pode_quitar_baixar() then',
      'if not public.crm_pode_desfazer_baixa() then');
    if position('crm_pode_desfazer_baixa' in d) = 0 then
      raise exception 'MIGRATION ABORTADA: nao achei o portao em desfazer_baixa_parcela.';
    end if;
    execute d;
  end if;
end $mig$;

create table if not exists public._backup_baixa_sem_lastro_20260909 (
  parcela_id uuid, acordo_id uuid, numero integer, valor numeric, honorario numeric,
  boleto text, pago_em timestamptz, status_acordo_antes text, resultado jsonb,
  em timestamptz default now()
);
alter table public._backup_baixa_sem_lastro_20260909 enable row level security;
drop policy if exists sem_acesso on public._backup_baixa_sem_lastro_20260909;
create policy sem_acesso on public._backup_baixa_sem_lastro_20260909 for select using (false);

create or replace function public.baixas_sem_lastro_excluir(p_confirmar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '240s'
as $fn$
declare
  v_n int := 0; v_valor numeric := 0; v_reabertos int := 0;
  r record; v_res jsonb;
begin
  create temp table _alvo on commit drop as
  select pa.id parcela_id, pa.acordo_id, pa.numero, pa.valor,
         coalesce(pa.honorarios,0) honorario, pa.boleto, pa.pago_em,
         ac.status status_acordo
    from public.parcelas pa
    join public.acordos ac on ac.id = pa.acordo_id
   where pa.status = 'PAGO'
     and pa.boleto is not null and length(pa.boleto) = 11
     and pa.confirmado_por_email is null              -- ninguem assumiu esta baixa
     and not exists (                                  -- e nao existe pagamento algum do acordo
           select 1 from public.pagamentos g
            where g.numero_parcela_completo is not null
              and substring(g.numero_parcela_completo,2,6) = substring(pa.boleto,2,6));

  select count(*), coalesce(sum(valor),0) into v_n, v_valor from _alvo;

  if not p_confirmar then
    return jsonb_build_object('ensaio', true, 'parcelas', v_n, 'valor', round(v_valor,2),
      'acordos_quitados_que_reabririam',
      (select count(distinct acordo_id) from _alvo where status_acordo='QUITADO'));
  end if;

  for r in select * from _alvo loop
    begin
      v_res := public.desfazer_baixa_parcela(r.parcela_id);
      if coalesce((v_res->>'acordo_reaberto')::boolean, false) then
        v_reabertos := v_reabertos + 1;
      end if;
    exception when others then
      v_res := jsonb_build_object('erro', sqlerrm);
    end;

    insert into public._backup_baixa_sem_lastro_20260909
      (parcela_id, acordo_id, numero, valor, honorario, boleto, pago_em, status_acordo_antes, resultado)
    values (r.parcela_id, r.acordo_id, r.numero, r.valor, r.honorario, r.boleto, r.pago_em,
            r.status_acordo, v_res);
  end loop;

  return jsonb_build_object('aplicado', true, 'parcelas', v_n, 'valor', round(v_valor,2),
                            'acordos_reabertos', v_reabertos);
end;
$fn$;

comment on function public.baixas_sem_lastro_excluir(boolean) is
  'Exclui a baixa de parcela que nenhum pagamento sustenta pelo numero do titulo E que ninguem confirmou. Baixa confirmada por gente NUNCA entra. Sem p_confirmar, so conta.';

revoke all on function public.baixas_sem_lastro_excluir(boolean) from public, anon, authenticated;

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('baixa_sem_lastro_no_titulo','GRAVE','Baixa que nenhum pagamento sustenta',
  'Parcela marcada como paga sem nenhum pagamento do acordo pelo numero do titulo, e sem ninguem ter confirmado. Se o titulo nao esta liquidado no Prime, nao pode estar baixado aqui.','135 · R$ 123.182,81, excluidas em 09/09')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo, explicacao = excluded.explicacao;

select public.baixas_sem_lastro_excluir(true);
