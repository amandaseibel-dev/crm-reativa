-- PREVENTIVO: a reducao do saldo depois de cada acao, e o consolidado que NAO
-- soma duas vezes o mesmo titulo.
--
-- O painel ja trazia antes/saiu/entradas/ajuste/depois por acao. Faltavam tres
-- coisas para a tela ficar legivel sem tradutor:
--
--   1. O PERCENTUAL, ao lado do valor e da quantidade. Numero absoluto sozinho
--      nao diz se R$ 4,2 milhoes e muito ou pouco para aquela base.
--   2. O PERIODO COMPARADO explicito -- de qual foto para qual foto. Sem isso
--      o leitor nao sabe o que "depois" significa em cada linha.
--   3. O CONSOLIDADO SEM DUPLA CONTAGEM. Este e o ponto delicado: as acoes se
--      sobrepoem. Nas tres de outubro, somar as reducoes da 12.373 titulos
--      quando a carteira inteira so perdeu 7.828 -- porque o mesmo titulo
--      acionado por e-mail e por WhatsApp sai UMA vez. Somar coluna seria
--      inflar o resultado em mais de 50%.
--
--      O consolidado conta TITULO DISTINTO que (a) esteve na base de alguma
--      acao com envio confirmado e (b) nao voltou na ultima foto comprovada
--      depois daquela acao. Cada titulo entra uma vez so, com o saldo que
--      tinha na remessa em que foi acionado pela primeira vez.
--
-- A PALAVRA CONTINUA SENDO REDUCAO OBSERVADA. Nao e pagamento confirmado: o
-- titulo saiu do relatorio, e a fonte nao diz por que.

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
           a.envio_confirmado_em, a.envio_precisao,
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
             limit 1) as depois_id
      from public.prev_acao a
      join public.prev_lote l on l.id = a.lote_id
     where a.carteira_id = p_carteira_id and a.cancelada_em is null
  ), base as (
    select ac.id as acao_id, d.titulo_id, x.saldo_na_remessa
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
  -- CONSOLIDADO SEM DUPLA CONTAGEM. Titulo distinto que saiu depois de ter
  -- sido acionado por ALGUMA acao com envio confirmado. Entra uma vez so, com
  -- o saldo da remessa em que foi acionado pela PRIMEIRA vez.
  saiu_uma_vez as (
    select distinct on (b.titulo_id) b.titulo_id, b.saldo_na_remessa
      from base b
      join conta k on k.id = b.acao_id
     where k.envio_confirmado_em is not null and k.depois_id is not null
       and not exists (select 1 from tl n where n.lote_id = k.depois_id and n.titulo_id = b.titulo_id)
     order by b.titulo_id, k.envio_confirmado_em
  ), acionado_uma_vez as (
    select distinct on (b.titulo_id) b.titulo_id, b.saldo_na_remessa
      from base b
      join conta k on k.id = b.acao_id
     where k.envio_confirmado_em is not null
     order by b.titulo_id, k.envio_confirmado_em
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
    -- O CONSOLIDADO DAS ACOES, cada titulo UMA vez.
    'acoes_consolidado', jsonb_build_object(
      'base_titulos', (select count(*) from acionado_uma_vez),
      'base_saldo',   (select coalesce(sum(saldo_na_remessa),0) from acionado_uma_vez),
      'reducao_titulos', (select count(*) from saiu_uma_vez),
      'reducao_valor',   (select coalesce(sum(saldo_na_remessa),0) from saiu_uma_vez),
      'reducao_pct_titulos', (select case when count(*) = 0 then null else
          round(100.0 * (select count(*) from saiu_uma_vez) / count(*), 1) end from acionado_uma_vez),
      'reducao_pct_valor', (select case when coalesce(sum(saldo_na_remessa),0) = 0 then null else
          round(100.0 * (select coalesce(sum(saldo_na_remessa),0) from saiu_uma_vez)
                      / sum(saldo_na_remessa), 1) end from acionado_uma_vez),
      'observacao', 'Cada título conta uma vez só. Somar as linhas da tabela acima '
                 || 'infla o resultado, porque a mesma pessoa pode ter sido acionada '
                 || 'por mais de um canal.'),
    'pontos', coalesce((select jsonb_agg(jsonb_build_object(
        'remessa', p.id, 'nome', p.nome, 'quando', p.extraido_em,
        'precisao', p.extraido_precisao, 'ordem_no_dia', p.ordem_no_dia, 'ordem', p.ordem,
        'titulos', p.titulos, 'saldo', p.saldo
      ) order by p.ordem) from pontos p), '[]'::jsonb),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', k.id, 'nome', k.nome, 'canal', k.canal, 'contexto', k.contexto,
        'origem', k.origem, 'estado', k.estado, 'publico', k.publico,
        'quando', k.envio_confirmado_em, 'precisao', k.envio_precisao,
        -- PERIODO COMPARADO, explicito: de qual foto para qual foto.
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
        -- COMPATIBILIDADE: o painel que esta no ar le `saiu`. Ele fica, com o
        -- mesmo conteudo de `reducao`, desde ESTA migration -- senao a tela
        -- quebraria na janela entre aplicar e subir o deploy.
        'saiu', jsonb_build_object('titulos', k.saiu_titulos, 'valor', k.saiu_valor),
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
      'REDUÇÃO DO SALDO APÓS A AÇÃO = o título estava na foto de onde o envio saiu e não '
   || 'está na primeira foto comprovadamente posterior. É movimento observado, NÃO pagamento '
   || 'confirmado: pode ser pagamento, cancelamento, bolsa, renegociação ou mudança do recorte '
   || 'na origem — a fonte não distingue. AJUSTE DE SALDO = variação de valor dos títulos que '
   || 'continuam nas duas fotos; existe para a conta fechar e NÃO é recuperação. '
   || 'As linhas por ação NÃO se somam: a mesma pessoa pode ter sido acionada por mais de um '
   || 'canal, e o consolidado conta cada título uma vez só.'
  ) into v;
  return v;
end;
$$;

comment on function public.preventivo_painel(uuid) is
  'Painel objetivo do Preventivo: carteira inicial, reducao observada, saldo restante, a '
  'serie por data e a reducao por acao com valor, percentual, titulos e periodo comparado. '
  'Traz tambem `acoes_consolidado`, que conta cada titulo UMA vez -- somar as linhas por '
  'acao inflaria o resultado, porque os publicos se sobrepoem.';
