-- Amanda, 31/08: "numero do documento e o numero de cada boleto" e
-- "baixa sempre tem que ser pelo numero do documento, a informacao precisa
-- casar para baixar".
--
-- O numero do boleto SOBE na planilha de acordo (coluna "Documento"), mas a
-- importacao so o gravava como TITULO (tipo_boleto='Acordo'). A parcela do
-- acordo -- que e onde o pagamento bate -- ficava sem numero. Os dois lados
-- existiam em tabelas diferentes, sem ligacao, e por isso a baixa nunca casava.
--
-- FORMATO DA CHAVE (medido em 31/08):
--   acordos_titulos.documento          = 12 digitos = "0" + "50" + titulo(5) + parcela(4)
--   pagamentos.numero_parcela_completo = 11 digitos = o mesmo, sem o zero da frente
--   => casam com ltrim(x,'0'); o numero do titulo e substr(documento,4,5).
--
-- Ver [[boleto-da-parcela-e-a-chave-do-pagamento]].

alter table public.parcelas add column if not exists boleto text;

-- um boleto pertence a UMA parcela e so uma.
create unique index if not exists ux_parcelas_boleto
  on public.parcelas (boleto) where boleto is not null;

create or replace function public.parcelas_amarrar_boleto()
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '300s'
as $function$
declare v_n int := 0;
begin
  -- Os 4 ultimos digitos do documento sao o numero da parcela. Amarra por
  -- aluno + numero + valor exato; medido em 31/08: 518 de 528 (98,1%).
  with tb as (
    select t.aluno_id, ltrim(t.documento,'0') chave, (right(t.documento,4))::int nr,
           coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) valor
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'')='Acordo' and t.documento ~ '^\d{8,}$'
  ), casado as (
    select distinct on (p.id) p.id parcela_id, tb.chave
      from tb join public.acordos a on a.aluno_id = tb.aluno_id
      join public.parcelas p on p.acordo_id = a.id and p.numero = tb.nr
     where abs(p.valor - tb.valor) <= 0.05 and p.boleto is null
     order by p.id, abs(p.valor - tb.valor)
  ), unico as (
    -- um boleto so pode apontar para UMA parcela
    select c.* from casado c where (select count(*) from casado c2 where c2.chave=c.chave)=1
      and not exists (select 1 from public.parcelas p3 where p3.boleto = c.chave)
  )
  update public.parcelas p set boleto = u.chave, atualizado_em = now()
    from unico u where p.id = u.parcela_id;
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'amarradas_agora', v_n,
    'total_com_boleto', (select count(*) from public.parcelas where boleto is not null),
    'sem_boleto', (select count(*) from public.parcelas where boleto is null));
end;
$function$;

revoke all on function public.parcelas_amarrar_boleto() from public, anon, authenticated;
grant execute on function public.parcelas_amarrar_boleto() to service_role;
