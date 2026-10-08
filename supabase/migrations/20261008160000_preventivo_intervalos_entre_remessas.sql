-- PREVENTIVO: a linha do tempo por INTERVALO entre remessas consecutivas.
--
-- POR QUE UMA FUNCAO NOVA, e nao mais um pedaco no painel.
--
-- O painel ja responde "o que aconteceu depois de cada ACAO". Essa pergunta
-- tem um defeito conhecido e assumido: os publicos se sobrepoem, entao as
-- linhas por acao NAO se somam -- o mesmo titulo acionado por e-mail e por
-- WhatsApp aparece nas duas.
--
-- A leitura gerencial precisa da outra pergunta: "o que aconteceu entre uma
-- foto e a seguinte". Essa fecha por construcao, porque cada intervalo e
-- disjunto e a soma dos movimentos liquidos e exatamente
-- saldo_final - saldo_inicial. Por isso ela vive aqui, separada, em vez de
-- virar mais uma chave numa funcao que ja esta grande: o painel nao muda uma
-- virgula, e nenhum numero ja exibido se mexe.
--
-- O QUE CADA INTERVALO TRAZ:
--
--   antes/depois        os dois extremos, em titulos e saldo;
--   saiu                estava na foto A e nao esta na B, pelo saldo que
--                       tinha em A -- movimento OBSERVADO, nunca pagamento;
--   entradas            esta na B e nao estava na A, pelo saldo em B;
--   ajuste              variacao de valor de quem ficou nas duas;
--   liquido             depois - antes, que e identicamente
--                       -saiu + entradas + ajuste. A conta FECHA, e ha teste.
--
--   acoes               as acoes cuja primeira foto comprovadamente posterior
--                       e justamente a foto que fecha este intervalo. Cada
--                       acao cai em UM intervalo so, entao nao ha sobreposicao
--                       -- e estar no intervalo NAO quer dizer que a reducao
--                       veio dela: o intervalo e o periodo, nao a causa.
--
--   ordem_comprovada    false quando as duas fotos sao do mesmo dia sem hora
--                       provada. Ordenar nao e comprovar: a tela mostra o
--                       aviso em vez de fingir sequencia.
--
-- Nada aqui inventa horario: a precisao de cada foto vai junto, e quem so tem
-- DATA continua sem hora.
create or replace function public.preventivo_intervalos(p_carteira_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

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
  ), fotos as (
    select l.id, l.nome, l.extraido_em, l.extraido_precisao, l.ordem_no_dia,
           row_number() over (order by public.preventivo_ordem(
             l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id)) as ordem
      from public.prev_lote l
     where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
  ), pares as (
    select f.id as ate_id, f.nome as ate_nome, f.extraido_em as ate_em,
           f.extraido_precisao as ate_prec, f.ordem,
           lag(f.id)                over (order by f.ordem) as de_id,
           lag(f.nome)              over (order by f.ordem) as de_nome,
           lag(f.extraido_em)       over (order by f.ordem) as de_em,
           lag(f.extraido_precisao) over (order by f.ordem) as de_prec,
           lag(f.ordem_no_dia)      over (order by f.ordem) as de_ordem_dia,
           f.ordem_no_dia as ate_ordem_dia
      from fotos f
  ), conta as (
    select p.*,
      (select count(*) from tl where lote_id = p.de_id) as antes_titulos,
      (select coalesce(sum(saldo_na_remessa),0) from tl where lote_id = p.de_id) as antes_saldo,
      (select count(*) from tl where lote_id = p.ate_id) as depois_titulos,
      (select coalesce(sum(saldo_na_remessa),0) from tl where lote_id = p.ate_id) as depois_saldo,
      (select count(*) from tl a where a.lote_id = p.de_id
        and not exists (select 1 from tl b where b.lote_id = p.ate_id and b.titulo_id = a.titulo_id)) as saiu_titulos,
      (select coalesce(sum(a.saldo_na_remessa),0) from tl a where a.lote_id = p.de_id
        and not exists (select 1 from tl b where b.lote_id = p.ate_id and b.titulo_id = a.titulo_id)) as saiu_valor,
      (select count(*) from tl b where b.lote_id = p.ate_id
        and not exists (select 1 from tl a where a.lote_id = p.de_id and a.titulo_id = b.titulo_id)) as entrou_titulos,
      (select coalesce(sum(b.saldo_na_remessa),0) from tl b where b.lote_id = p.ate_id
        and not exists (select 1 from tl a where a.lote_id = p.de_id and a.titulo_id = b.titulo_id)) as entrou_valor,
      (select coalesce(sum(b.saldo_na_remessa - a.saldo_na_remessa),0)
         from tl a join tl b on b.titulo_id = a.titulo_id and b.lote_id = p.ate_id
        where a.lote_id = p.de_id) as ajuste
      from pares p
     where p.de_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'ordem', k.ordem - 1,
      'de',    jsonb_build_object('remessa', k.de_id, 'nome', k.de_nome,
                                  'quando', k.de_em, 'precisao', k.de_prec),
      'ate',   jsonb_build_object('remessa', k.ate_id, 'nome', k.ate_nome,
                                  'quando', k.ate_em, 'precisao', k.ate_prec),
      'ordem_comprovada', public.preventivo_sequencia_comprovada(
          k.de_em, k.de_prec, k.de_ordem_dia, k.ate_em, k.ate_prec, k.ate_ordem_dia),
      'antes',  jsonb_build_object('titulos', k.antes_titulos,  'saldo', k.antes_saldo),
      'depois', jsonb_build_object('titulos', k.depois_titulos, 'saldo', k.depois_saldo),
      'saiu',     jsonb_build_object('titulos', k.saiu_titulos,   'valor', k.saiu_valor),
      'entradas', jsonb_build_object('titulos', k.entrou_titulos, 'valor', k.entrou_valor),
      'ajuste', k.ajuste,
      -- IDENTIDADE: liquido = depois - antes = -saiu + entradas + ajuste.
      'liquido', k.depois_saldo - k.antes_saldo,
      'liquido_titulos', k.depois_titulos - k.antes_titulos,
      'pct_saldo', case when k.antes_saldo = 0 then null
                        else round(100.0 * (k.depois_saldo - k.antes_saldo) / k.antes_saldo, 1) end,
      'acoes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', a.id, 'nome', a.nome, 'canal', a.canal, 'contexto', a.contexto,
                 'quando', a.envio_confirmado_em, 'precisao', a.envio_precisao,
                 'custo_informado', (a.custo_total is not null), 'custo_total', a.custo_total)
               order by a.envio_confirmado_em)
          from public.prev_acao a
         where a.carteira_id = p_carteira_id and a.cancelada_em is null
           and a.envio_confirmado_em is not null
           -- a acao pertence ao intervalo que termina na sua PRIMEIRA foto
           -- comprovadamente posterior: um intervalo so, sem sobreposicao.
           and k.ate_id = (
             select l2.id from public.prev_lote l2
              where l2.carteira_id = p_carteira_id and l2.status = 'CONFIRMADO'
                and (public.preventivo_dia(l2.extraido_em) > public.preventivo_dia(a.envio_confirmado_em)
                     or (public.preventivo_dia(l2.extraido_em) = public.preventivo_dia(a.envio_confirmado_em)
                         and l2.extraido_precisao = 'DATA_E_HORA' and a.envio_precisao = 'DATA_E_HORA'
                         and l2.extraido_em > a.envio_confirmado_em))
              order by public.preventivo_ordem(l2.extraido_em, l2.extraido_precisao,
                                               l2.ordem_no_dia, l2.criado_em, l2.id)
              limit 1)), '[]'::jsonb)
    ) order by k.ordem), '[]'::jsonb) into v
    from conta k;

  return v;
end;
$$;

comment on function public.preventivo_intervalos(uuid) is
  'Linha do tempo do Preventivo por intervalo entre remessas CONSECUTIVAS. Intervalos '
  'disjuntos: o liquido de cada um e depois-antes, identicamente -saiu+entradas+ajuste, '
  'e a soma deles fecha com saldo final menos saldo inicial. Cada acao cai em um '
  'intervalo so -- o que termina na sua primeira foto comprovadamente posterior -- e '
  'isso e PERIODO, nao causa. Movimento observado, nunca pagamento confirmado.';

-- Funcao nova NAO herda os grants da view: tem de ser explicito (e o portao de
-- gestao fica DENTRO, nunca por revoke de authenticated).
revoke all on function public.preventivo_intervalos(uuid) from public, anon;
grant execute on function public.preventivo_intervalos(uuid) to authenticated;
