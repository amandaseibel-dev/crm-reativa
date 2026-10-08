-- PREVENTIVO: custo da acao, consolidado que trata reentrada, e compatibilidade.
--
-- QUATRO COISAS.
--
-- 1. CUSTO DA ACAO. Campo opcional, em reais. NULL e "nao informado"; 0 e
--    "informado como zero" -- sao estados diferentes e a tela mostra cada um
--    com palavra propria. Negativo e recusado. Pode ser preenchido no registro
--    ou depois, pela mesma funcao.
--
--    O custo NAO entra em nenhuma conta da carteira: nao desconta do saldo,
--    nao vira ROI. Ele aparece ao lado do resultado, e quem le decide.
--
-- 2. O CONSOLIDADO PASSA A TRATAR REENTRADA. A versao anterior olhava a foto
--    seguinte de cada acao isoladamente. Titulo que saiu depois do e-mail e
--    VOLTOU antes do WhatsApp era contado como reduzido -- e ele esta la, em
--    aberto. Agora a pergunta e feita contra a ULTIMA foto comprovada depois
--    do ULTIMO acionamento daquele titulo: se ele reapareceu, nao conta.
--
--    O saldo usado continua sendo o do PRIMEIRO acionamento -- e o valor que
--    estava em jogo quando a acao comecou.
--
-- 3. PENDENTE NAO E ZERO. Titulo acionado para o qual ainda nao existe remessa
--    posterior comprovada fica em `pendentes_titulos` e sai da base do
--    percentual. Mostrar zero diria "nao saiu ninguem", quando o certo e
--    "ainda nao da para saber".
--
-- 4. COMPATIBILIDADE NA JANELA DO DEPLOY. A funcao devolve `reducao` E o
--    antigo `saiu` com o mesmo conteudo. Assim a tela velha continua lendo
--    enquanto a migration ja esta aplicada e o deploy ainda nao subiu. O
--    `saiu` sai numa limpeza futura, nao aqui.

-- -----------------------------------------------------------------------------
-- 1. O CAMPO DE CUSTO
-- -----------------------------------------------------------------------------
alter table public.prev_acao add column if not exists custo_total numeric(14,2);

alter table public.prev_acao drop constraint if exists prev_acao_custo_total_nao_negativo;
alter table public.prev_acao add constraint prev_acao_custo_total_nao_negativo
  check (custo_total is null or custo_total >= 0);

comment on column public.prev_acao.custo_total is
  'Custo total da acao em reais, informado pela gestao. NULL = nao informado; '
  '0 = informado como zero -- a tela distingue os dois. Negativo e recusado. '
  'NAO entra em conta nenhuma da carteira: nao desconta do saldo e nao vira ROI.';

create or replace function public.preventivo_acao_custo_definir(
  p_acao_id uuid, p_custo numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_carteira uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_custo is not null and p_custo < 0 then
    raise exception 'O custo não pode ser negativo.' using errcode = '22023';
  end if;

  select carteira_id into v_carteira from public.prev_acao where id = p_acao_id;
  if v_carteira is null then
    raise exception 'Ação não encontrada.' using errcode = '22023';
  end if;

  -- NULL limpa o campo de volta para "nao informado"; 0 grava zero.
  update public.prev_acao set custo_total = p_custo where id = p_acao_id;

  return jsonb_build_object('acao', p_acao_id, 'custo_total', p_custo,
                            'informado', (p_custo is not null));
end;
$$;

comment on function public.preventivo_acao_custo_definir(uuid, numeric) is
  'Define ou limpa o custo total de uma acao. NULL volta para nao informado, 0 grava '
  'zero, negativo e recusado. Pode ser chamada no registro ou depois.';

revoke all on function public.preventivo_acao_custo_definir(uuid, numeric) from public, anon;
grant execute on function public.preventivo_acao_custo_definir(uuid, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. O PAINEL
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_painel(p_carteira_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_primeiro uuid; v_ultimo uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select id into v_primeiro from public.prev_lote
   where carteira_id = p_carteira_id and status = 'CONFIRMADO'
   order by public.preventivo_ordem(extraido_em, extraido_precisao, ordem_no_dia, criado_em, id)
   limit 1;
  select id into v_ultimo from public.prev_lote
   where carteira_id = p_carteira_id and status = 'CONFIRMADO'
   order by public.preventivo_ordem(extraido_em, extraido_precisao, ordem_no_dia, criado_em, id) desc
   limit 1;

  with carteira as (select venc_de, venc_ate from public.prev_carteira where id = p_carteira_id),
  dentro as (
    select t.id
      from public.prev_titulo t, carteira c
     where t.carteira_id = p_carteira_id
       and (t.vencimento_origem is null
            or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate))
  ), tl as (
    select x.lote_id, x.titulo_id, x.saldo_na_remessa
      from public.prev_titulo_lote x
      join dentro d on d.id = x.titulo_id
  ), remessas as (
    select l.id, l.nome, l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em,
           row_number() over (order by public.preventivo_ordem(
             l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id)) as ordem
      from public.prev_lote l
     where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
  ), fotos as (
    select r.*,
           (select count(*) from tl where tl.lote_id = r.id) as titulos,
           (select coalesce(sum(saldo_na_remessa), 0) from tl where tl.lote_id = r.id) as saldo
      from remessas r
  ), pontos as (
    select f.*,
           case when lag(f.id) over (order by f.ordem) is null then null
                else public.preventivo_sequencia_comprovada(
                       lag(f.extraido_em)       over (order by f.ordem),
                       lag(f.extraido_precisao) over (order by f.ordem),
                       lag(f.ordem_no_dia)      over (order by f.ordem),
                       f.extraido_em, f.extraido_precisao, f.ordem_no_dia) end as par_comprovado
      from fotos f
  ), acoes as (
    select a.id, a.nome, a.canal, a.contexto, a.origem, a.estado, a.lote_id,
           a.envio_confirmado_em, a.envio_precisao, a.custo_total,
           coalesce(a.filtros->>'publico', 'remessa_inteira') as publico,
           l.nome as remessa_nome, l.extraido_em as remessa_em, l.extraido_precisao as remessa_prec,
           (select l2.id from public.prev_lote l2
             where l2.carteira_id = p_carteira_id and l2.status = 'CONFIRMADO'
               and a.envio_confirmado_em is not null
               and (public.preventivo_dia(l2.extraido_em) > public.preventivo_dia(a.envio_confirmado_em)
                    or (public.preventivo_dia(l2.extraido_em) = public.preventivo_dia(a.envio_confirmado_em)
                        and l2.extraido_precisao = 'DATA_E_HORA' and a.envio_precisao = 'DATA_E_HORA'
                        and l2.extraido_em > a.envio_confirmado_em))
             order by public.preventivo_ordem(l2.extraido_em, l2.extraido_precisao,
                                              l2.ordem_no_dia, l2.criado_em, l2.id)
             limit 1) as depois_id,
           -- A ULTIMA foto comprovada depois do envio. O card da acao usa a
           -- PRIMEIRA (efeito imediato, com periodo declarado); o consolidado
           -- usa esta, porque so a ultima revela reentrada.
           (select l2.id from public.prev_lote l2
             where l2.carteira_id = p_carteira_id and l2.status = 'CONFIRMADO'
               and a.envio_confirmado_em is not null
               and (public.preventivo_dia(l2.extraido_em) > public.preventivo_dia(a.envio_confirmado_em)
                    or (public.preventivo_dia(l2.extraido_em) = public.preventivo_dia(a.envio_confirmado_em)
                        and l2.extraido_precisao = 'DATA_E_HORA' and a.envio_precisao = 'DATA_E_HORA'
                        and l2.extraido_em > a.envio_confirmado_em))
             order by public.preventivo_ordem(l2.extraido_em, l2.extraido_precisao,
                                              l2.ordem_no_dia, l2.criado_em, l2.id) desc
             limit 1) as ultima_depois_id
      from public.prev_acao a
      join public.prev_lote l on l.id = a.lote_id
     where a.carteira_id = p_carteira_id and a.cancelada_em is null
  ), base as (
    select ac.id as acao_id, ac.envio_confirmado_em, ac.depois_id, ac.ultima_depois_id,
           d.titulo_id, x.saldo_na_remessa
      from acoes ac
      join public.prev_acao_destinatario d on d.acao_id = ac.id and d.incluido
      join tl x on x.titulo_id = d.titulo_id and x.lote_id = ac.lote_id
  ), conta as (
    select ac.*,
      (select count(*) from base b where b.acao_id = ac.id) as antes_titulos,
      (select coalesce(sum(b.saldo_na_remessa), 0) from base b where b.acao_id = ac.id) as antes_saldo,
      (select count(distinct d.matricula) from public.prev_acao_destinatario d
        join dentro dd on dd.id = d.titulo_id
       where d.acao_id = ac.id and d.incluido) as antes_alunos,
      case when ac.depois_id is null then null else (
        select count(*) from base b where b.acao_id = ac.id
          and not exists (select 1 from tl n where n.lote_id = ac.depois_id and n.titulo_id = b.titulo_id)) end as saiu_titulos,
      case when ac.depois_id is null then null else (
        select coalesce(sum(b.saldo_na_remessa), 0) from base b where b.acao_id = ac.id
          and not exists (select 1 from tl n where n.lote_id = ac.depois_id and n.titulo_id = b.titulo_id)) end as saiu_valor,
      case when ac.depois_id is null or ac.publico <> 'remessa_inteira' then null else (
        select count(*) from tl n where n.lote_id = ac.depois_id
          and not exists (select 1 from base b where b.acao_id = ac.id and b.titulo_id = n.titulo_id)) end as entradas_titulos,
      case when ac.depois_id is null or ac.publico <> 'remessa_inteira' then null else (
        select coalesce(sum(n.saldo_na_remessa), 0) from tl n where n.lote_id = ac.depois_id
          and not exists (select 1 from base b where b.acao_id = ac.id and b.titulo_id = n.titulo_id)) end as entradas_valor,
      case when ac.depois_id is null then null else (
        select coalesce(sum(n.saldo_na_remessa - b.saldo_na_remessa), 0)
          from base b join tl n on n.titulo_id = b.titulo_id and n.lote_id = ac.depois_id
         where b.acao_id = ac.id) end as ajuste_saldo,
      case when ac.depois_id is null then null else (
        select count(*) from tl n where n.lote_id = ac.depois_id) end as remessa_depois_titulos,
      case when ac.depois_id is null then null else (
        select coalesce(sum(n.saldo_na_remessa), 0) from tl n where n.lote_id = ac.depois_id) end as remessa_depois_saldo,
      (select count(*) > 0 from public.prev_lote l3
        where l3.carteira_id = p_carteira_id and l3.status = 'CONFIRMADO'
          and l3.id <> ac.lote_id
          and ac.envio_confirmado_em is not null
          and public.preventivo_dia(l3.extraido_em) = public.preventivo_dia(ac.envio_confirmado_em)
          and (l3.extraido_precisao <> 'DATA_E_HORA' or ac.envio_precisao <> 'DATA_E_HORA')) as mesmo_dia_sem_hora
      from acoes ac
  ),
  -- -------- CONSOLIDADO, UM TITULO = UMA LINHA --------
  -- Saldo do PRIMEIRO acionamento; veredito contra a ULTIMA foto comprovada
  -- depois do ULTIMO acionamento daquele titulo. E assim que reentrada e
  -- tratada: se o titulo voltou, ele esta na ultima foto e nao conta.
  acionado as (
    select b.titulo_id,
           (array_agg(b.saldo_na_remessa order by b.envio_confirmado_em))[1] as saldo_primeiro,
           max(b.envio_confirmado_em) as ultimo_envio,
           (array_remove(array_agg(b.ultima_depois_id order by b.envio_confirmado_em desc), null))[1] as regua
      from base b
     where b.envio_confirmado_em is not null
     group by b.titulo_id
  ), veredito as (
    select a.titulo_id, a.saldo_primeiro, a.regua,
           case when a.regua is null then null
                else not exists (select 1 from tl n
                                  where n.lote_id = a.regua and n.titulo_id = a.titulo_id) end as reduziu
      from acionado a
  )
  select jsonb_build_object(
    'cards', jsonb_build_object(
      'inicio', jsonb_build_object(
        'titulos', (select count(*) from tl where lote_id = v_primeiro),
        'saldo',   (select coalesce(sum(saldo_na_remessa), 0) from tl where lote_id = v_primeiro),
        'quando',  (select extraido_em from public.prev_lote where id = v_primeiro),
        'precisao',(select extraido_precisao from public.prev_lote where id = v_primeiro)),
      'saiu', jsonb_build_object(
        'titulos', case when v_primeiro = v_ultimo then 0 else (
          select count(*) from tl a where a.lote_id = v_primeiro
            and not exists (select 1 from tl b where b.lote_id = v_ultimo and b.titulo_id = a.titulo_id)) end,
        'valor', case when v_primeiro = v_ultimo then 0 else (
          select coalesce(sum(a.saldo_na_remessa), 0) from tl a where a.lote_id = v_primeiro
            and not exists (select 1 from tl b where b.lote_id = v_ultimo and b.titulo_id = a.titulo_id)) end),
      'hoje', jsonb_build_object(
        'titulos', (select count(*) from tl where lote_id = v_ultimo),
        'saldo',   (select coalesce(sum(saldo_na_remessa), 0) from tl where lote_id = v_ultimo),
        'quando',  (select extraido_em from public.prev_lote where id = v_ultimo),
        'precisao',(select extraido_precisao from public.prev_lote where id = v_ultimo)),
      'alunos_acionados', (
        select case when count(*) filter (where a.envio_confirmado_em is not null) = 0 then null
                    else count(distinct d.matricula) filter (where a.envio_confirmado_em is not null) end
          from public.prev_acao a
          join public.prev_acao_destinatario d on d.acao_id = a.id and d.incluido
          join dentro dd on dd.id = d.titulo_id
         where a.carteira_id = p_carteira_id and a.cancelada_em is null),
      'remessas', (select count(*) from pontos),
      'ordem_ambigua', coalesce((select bool_or(p.par_comprovado is not null and not p.par_comprovado)
                                   from pontos p), false)),
    'acoes_consolidado', jsonb_build_object(
      'base_titulos', (select count(*) from veredito),
      'base_saldo',   (select coalesce(sum(saldo_primeiro),0) from veredito),
      'pendentes_titulos', (select count(*) from veredito where reduziu is null),
      'pendentes_saldo',   (select coalesce(sum(saldo_primeiro),0) from veredito where reduziu is null),
      'com_regua_titulos', (select count(*) from veredito where reduziu is not null),
      'reducao_titulos', (select case when count(*) filter (where reduziu is not null) = 0 then null
                                      else count(*) filter (where reduziu) end from veredito),
      'reducao_valor',   (select case when count(*) filter (where reduziu is not null) = 0 then null
                                      else coalesce(sum(saldo_primeiro) filter (where reduziu),0) end from veredito),
      'reducao_pct_titulos', (select case when count(*) filter (where reduziu is not null) = 0 then null
          else round(100.0 * count(*) filter (where reduziu) / count(*) filter (where reduziu is not null), 1) end
          from veredito),
      'reducao_pct_valor', (select case
          when coalesce(sum(saldo_primeiro) filter (where reduziu is not null),0) = 0 then null
          else round(100.0 * coalesce(sum(saldo_primeiro) filter (where reduziu),0)
                           / sum(saldo_primeiro) filter (where reduziu is not null), 1) end
          from veredito),
      'custo_total', (select case when count(*) filter (where custo_total is not null) = 0 then null
                                  else coalesce(sum(custo_total),0) end from acoes),
      'observacao', 'Cada título conta uma vez só, com o saldo do primeiro acionamento, e o '
                 || 'veredito é dado contra a última foto comprovada depois do último '
                 || 'acionamento dele — título que saiu e voltou não conta como redução. '
                 || 'Somar as linhas por ação infla o resultado.'),
    'pontos', coalesce((select jsonb_agg(jsonb_build_object(
        'remessa', p.id, 'nome', p.nome, 'quando', p.extraido_em,
        'precisao', p.extraido_precisao, 'ordem_no_dia', p.ordem_no_dia, 'ordem', p.ordem,
        'titulos', p.titulos, 'saldo', p.saldo
      ) order by p.ordem) from pontos p), '[]'::jsonb),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', k.id, 'nome', k.nome, 'canal', k.canal, 'contexto', k.contexto,
        'origem', k.origem, 'estado', k.estado, 'publico', k.publico,
        'quando', k.envio_confirmado_em, 'precisao', k.envio_precisao,
        'periodo', jsonb_build_object(
          'de_nome', k.remessa_nome, 'de_quando', k.remessa_em, 'de_precisao', k.remessa_prec,
          'ate_nome', (select l.nome from public.prev_lote l where l.id = k.depois_id),
          'ate_quando', (select l.extraido_em from public.prev_lote l where l.id = k.depois_id),
          'ate_precisao', (select l.extraido_precisao from public.prev_lote l where l.id = k.depois_id)),
        'antes', jsonb_build_object('titulos', k.antes_titulos, 'saldo', k.antes_saldo,
                                    'alunos', k.antes_alunos),
        'reducao', jsonb_build_object(
          'titulos', k.saiu_titulos, 'valor', k.saiu_valor,
          'pct_titulos', case when k.saiu_titulos is null or k.antes_titulos = 0 then null
                              else round(100.0 * k.saiu_titulos / k.antes_titulos, 1) end,
          'pct_valor', case when k.saiu_valor is null or k.antes_saldo = 0 then null
                            else round(100.0 * k.saiu_valor / k.antes_saldo, 1) end),
        -- COMPATIBILIDADE: a tela anterior le `saiu`. Fica, com o mesmo
        -- conteudo, para a janela entre aplicar a migration e subir o deploy.
        'saiu', jsonb_build_object('titulos', k.saiu_titulos, 'valor', k.saiu_valor),
        'custo', jsonb_build_object(
          'informado', (k.custo_total is not null),
          'total', k.custo_total,
          'por_aluno', case when k.custo_total is null or coalesce(k.antes_alunos,0) = 0 then null
                            else round(k.custo_total / k.antes_alunos, 2) end),
        'entradas', jsonb_build_object('titulos', k.entradas_titulos, 'valor', k.entradas_valor),
        'ajuste_saldo', k.ajuste_saldo,
        'depois', jsonb_build_object(
          'titulos', case when k.depois_id is null then null
                          when k.publico = 'remessa_inteira' then k.remessa_depois_titulos
                          else k.antes_titulos - k.saiu_titulos end,
          'saldo', case when k.depois_id is null then null
                        when k.publico = 'remessa_inteira' then k.remessa_depois_saldo
                        else k.antes_saldo - k.saiu_valor + k.ajuste_saldo end),
        'sem_envio_confirmado', (k.envio_confirmado_em is null),
        'aguardando_remessa', (k.envio_confirmado_em is not null and k.depois_id is null
                               and not k.mesmo_dia_sem_hora),
        'sequencia_nao_comprovada', (k.depois_id is null and k.mesmo_dia_sem_hora)
      ) order by k.envio_confirmado_em nulls last) from conta k), '[]'::jsonb),
    'definicao',
      'REDUÇÃO OBSERVADA APÓS A AÇÃO = o título estava na foto de onde o envio saiu e não '
   || 'está na primeira foto comprovadamente posterior. É movimento observado no período, '
   || 'NÃO efeito comprovado do envio e NÃO pagamento confirmado: pode ser pagamento, '
   || 'cancelamento, bolsa, renegociação ou mudança do recorte na origem — a fonte não '
   || 'distingue, e nada aqui atribui a saída à ação. AJUSTE DE SALDO = variação de valor '
   || 'dos títulos que continuam nas duas fotos; existe para a conta fechar e NÃO é '
   || 'recuperação. As linhas por ação NÃO se somam: o consolidado conta cada título uma '
   || 'vez. CUSTO não entra em conta nenhuma da carteira.'
  ) into v;
  return v;
end;
$$;
