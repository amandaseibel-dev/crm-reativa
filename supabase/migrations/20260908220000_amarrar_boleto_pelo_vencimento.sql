-- Amarracao do boleto pelo vencimento, nao pelo sufixo.
--
-- Amanda, 08/09/2026: "colocamos sempre a baixa amarrada ao numero do titulo"
-- e "faca tudo que puder automatizado". A guarda (PR #320) parou as baixas
-- erradas e o reparo (PR #321) arrumou as 89 ja feitas. Falta a causa: a
-- rotina que decide QUAL parcela carrega QUAL documento.
--
-- `parcelas_amarrar_boleto` assumia "4 ultimos digitos do documento = numero
-- da parcela". Medido em 08/09: vale em 5.969 de 10.924 parcelas; 3.884 tem
-- deslocamento +1 (o doc 0001 costuma ser a entrada) e ~1.070 tem +2 a +9. Das
-- 303 ancoras disponiveis (titulo de acordo com vencimento igual ao de uma
-- parcela), 302 contradiziam o boleto gravado.
--
-- O QUE MUDA:
-- 1. `parcelas.boleto_confiavel`: true quando o boleto foi amarrado por
--    VENCIMENTO (titulo de acordo com vencimento, linha do extrato com
--    vencimento, ou deslocamento derivado deles). So esses servem de ancora.
-- 2. `parcelas_amarrar_boleto`:
--    A. titulo tipo Acordo -> parcela do mesmo aluno com o mesmo vencimento
--       (+-3 dias) e o mesmo valor;
--    B. linha do extrato com aluno e vencimento -> parcela do aluno com aquele
--       vencimento e valor compativel (ate 15% de acrescimo);
--    0. nos acordos que ganharam ancora, o boleto legado (nao confiavel) que
--       conflita -- mesma chave em outra parcela, ou deslocamento diferente do
--       real -- e apagado;
--    C. deslocamento: acordo com ancora confiavel e deslocamento unico preenche
--       as parcelas sem boleto (prefixo do titulo + numero + deslocamento);
--    D. o casamento antigo por sufixo fica so para acordo SEM nenhuma ancora,
--       marcado como nao confiavel (a guarda da baixa cuida do resto).
-- 3. Roda a amarracao uma vez ao fim (o cron das :25 continua chamando-a).
--
-- Boleto e so a CHAVE de casamento: esta migration nao muda status de parcela
-- nem registra pagamento. O que ela reescreve e recuperavel pelo backup
-- `_backup_boletos_antes_reamarracao_20260908`.

alter table public.parcelas add column if not exists boleto_confiavel boolean not null default false;
comment on column public.parcelas.boleto_confiavel is
  'true = boleto amarrado por vencimento (titulo com vencimento, extrato com vencimento, ou deslocamento derivado deles). false = casamento antigo por sufixo, que pode estar deslocado.';

create table if not exists public._backup_boletos_antes_reamarracao_20260908 as
  select id as parcela_id, acordo_id, numero, vencimento, valor, boleto, now() as salvo_em
    from public.parcelas where boleto is not null;
alter table public._backup_boletos_antes_reamarracao_20260908 enable row level security;

create or replace function public.parcelas_amarrar_boleto()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $$
declare v_anc int := 0; v_limpos int := 0; v_limpos2 int := 0; v_desloc int := 0; v_legado int := 0;
begin
  -- Donos de cada prefixo de titulo (documento sem os 4 ultimos digitos), pelo
  -- Relatorio de Titulos em Aberto. E o unico vinculo aluno <-> documento
  -- aceito: numero do titulo, nunca nome (Amanda, 08/09).
  create temp table _tp on commit drop as
  select distinct left(ltrim(documento,'0'), length(ltrim(documento,'0'))-4) prefixo, aluno_id
    from public.acordos_titulos where documento ~ '^\d{8,}$' and aluno_id is not null;
  create index on _tp(prefixo);

  -- A. titulo tipo Acordo com vencimento -> parcela do mesmo aluno, mesmo
  --    vencimento (+-3 dias) e mesmo valor.
  create temp table _anc on commit drop as
  select distinct on (p.id) p.id parcela_id, p.acordo_id, ltrim(t.documento,'0') chave, 'titulo'::text origem
    from public.acordos_titulos t
    join public.acordos a on a.aluno_id = t.aluno_id and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    join public.parcelas p on p.acordo_id = a.id and abs(p.vencimento - t.vencimento) <= 3
   where coalesce(t.tipo_boleto,'') = 'Acordo' and t.documento ~ '^\d{8,}$'
     and abs(p.valor - coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) <= 0.05
   order by p.id, abs(p.vencimento - t.vencimento);

  -- B. linha do extrato com vencimento -> parcela do acordo cujo aluno e dono
  --    do PREFIXO do documento (pelo titulo, ou por boleto confiavel do mesmo
  --    acordo). O nome do extrato nao entra: e o pagador, nao o dono.
  insert into _anc
  select distinct on (p.id) p.id, p.acordo_id, px.chave, 'pagamento'
    from public.pagamentos g
    cross join lateral (select ltrim(g.numero_parcela_completo,'0') chave,
                               left(ltrim(g.numero_parcela_completo,'0'), length(ltrim(g.numero_parcela_completo,'0'))-4) prefixo) px
    join public.acordos a on upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
         and (exists (select 1 from _tp t where t.prefixo = px.prefixo and t.aluno_id = a.aluno_id)
              or exists (select 1 from public.parcelas pc where pc.acordo_id = a.id and pc.boleto_confiavel and left(pc.boleto, length(pc.boleto)-4) = px.prefixo))
    join public.parcelas p on p.acordo_id = a.id and abs(p.vencimento - public.vencimento_do_pagamento(g.dados)) <= 3
   where public.vencimento_do_pagamento(g.dados) is not null
     and coalesce(g.numero_parcela_completo,'') ~ '^\d{8,}$'
     and g.valor_pago >= p.valor - 0.05 and g.valor_pago <= p.valor * 1.15
     and not exists (select 1 from _anc x where x.parcela_id = p.id)
   order by p.id, abs(p.vencimento - public.vencimento_do_pagamento(g.dados));

  -- Uma chave, uma parcela. Chave que apontou para duas parcelas nao ancora.
  delete from _anc x where (select count(*) from _anc y where y.chave = x.chave) > 1;

  -- 0. Boleto legado que conflita com a ancora sai do caminho.
  update public.parcelas p set boleto = null, atualizado_em = now()
    from _anc x
   where x.chave = p.boleto and x.parcela_id <> p.id and not p.boleto_confiavel;
  get diagnostics v_limpos = row_count;

  with ofs as (
    select x.acordo_id, (right(x.chave,4))::int - p.numero as off
      from _anc x join public.parcelas p on p.id = x.parcela_id
  ), ofs_u as (
    select acordo_id, min(off) as off from ofs group by acordo_id having min(off) = max(off)
  )
  update public.parcelas p set boleto = null, atualizado_em = now()
    from ofs_u o
   where p.acordo_id = o.acordo_id and p.boleto is not null and not p.boleto_confiavel
     and p.boleto ~ '^\d{8,}$'
     and (right(p.boleto,4))::int - p.numero <> o.off;
  get diagnostics v_limpos2 = row_count;
  v_limpos := v_limpos + v_limpos2;

  -- 1. Grava as ancoras.
  update public.parcelas p
     set boleto = x.chave, boleto_confiavel = true, atualizado_em = now()
    from _anc x
   where p.id = x.parcela_id
     and (p.boleto is distinct from x.chave or not p.boleto_confiavel)
     and not exists (select 1 from public.parcelas z where z.boleto = x.chave and z.id <> p.id);
  get diagnostics v_anc = row_count;

  -- 2. Deslocamento: acordo com ancora confiavel e deslocamento unico preenche
  --    as parcelas sem boleto (prefixo do titulo + numero + deslocamento).
  with conf as (
    select p.acordo_id, left(p.boleto, length(p.boleto) - 4) as prefixo, (right(p.boleto,4))::int - p.numero as off
      from public.parcelas p where p.boleto_confiavel and p.boleto ~ '^\d{8,}$'
  ), u as (
    select acordo_id, min(prefixo) as prefixo, min(off) as off
      from conf group by acordo_id
    having min(off) = max(off) and min(prefixo) = max(prefixo)
  ), alvo as (
    select p.id, u.prefixo || lpad((p.numero + u.off)::text, 4, '0') as chave
      from public.parcelas p join u on u.acordo_id = p.acordo_id
     where p.boleto is null and p.numero + u.off between 1 and 9999
  )
  update public.parcelas p
     set boleto = alvo.chave, boleto_confiavel = true, atualizado_em = now()
    from alvo
   where p.id = alvo.id
     and not exists (select 1 from public.parcelas z where z.boleto = alvo.chave);
  get diagnostics v_desloc = row_count;

  -- 3. Legado: o casamento por sufixo so para acordo SEM nenhuma ancora, e
  --    marcado como nao confiavel.
  with tb as (
    select t.aluno_id, ltrim(t.documento,'0') chave, (right(t.documento,4))::int nr,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'') = 'Acordo' and t.documento ~ '^\d{8,}$'
  ), casado as (
    select distinct on (p.id) p.id parcela_id, tb.chave
      from tb join public.acordos a on a.aluno_id = tb.aluno_id
      join public.parcelas p on p.acordo_id = a.id and p.numero = tb.nr
     where abs(p.valor - tb.valor) <= 0.05 and p.boleto is null
       and not exists (select 1 from public.parcelas c where c.acordo_id = a.id and c.boleto_confiavel)
     order by p.id, abs(p.valor - tb.valor)
  ), unico as (
    select c.* from casado c
     where (select count(*) from casado c2 where c2.chave = c.chave) = 1
       and not exists (select 1 from public.parcelas p3 where p3.boleto = c.chave)
  )
  update public.parcelas p set boleto = u.chave, boleto_confiavel = false, atualizado_em = now()
    from unico u where p.id = u.parcela_id;
  get diagnostics v_legado = row_count;

  return jsonb_build_object(
    'ancoras_gravadas', v_anc,
    'legados_limpos', v_limpos,
    'por_deslocamento', v_desloc,
    'legado_por_sufixo', v_legado,
    'total_com_boleto', (select count(*) from public.parcelas where boleto is not null),
    'total_confiavel', (select count(*) from public.parcelas where boleto_confiavel),
    'sem_boleto', (select count(*) from public.parcelas where boleto is null));
end;
$$;

comment on function public.parcelas_amarrar_boleto() is
  'Amarra o documento (boleto) a parcela pelo VENCIMENTO: titulos de acordo e linhas do extrato com vencimento como ancora, deslocamento derivado delas para as demais; casamento por sufixo so onde nao ha ancora (boleto_confiavel=false). Cron das :25.';

select public.parcelas_amarrar_boleto();
