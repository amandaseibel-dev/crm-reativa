-- PREVENTIVO: um painel que a gestao le sem tradutor.
--
-- A aba Resultados virou um mostruario tecnico: janela preventiva, fora da
-- janela, nunca consultado no Prime, alteracao de netAmount, conferencia de
-- fechamento da fonte. Tudo isso continua CERTO e continua no banco -- mas
-- nenhuma dessas linhas responde a pergunta que a gestao faz, que e:
--
--   quanto a carteira tinha quando comecamos, quanto saiu, e quanto sobrou.
--
-- Esta funcao responde SO isso, mais o acompanhamento por acao. Nao cria
-- regra nova, nao apaga nada e nao toca em nenhuma das funcoes existentes:
-- e uma LEITURA a mais, construida sobre o mesmo recorte de origem e a mesma
-- prova de sequencia que as demais ja usam.
--
-- A CONTA FECHA, E E ISSO QUE OBRIGA O AJUSTE A APARECER. Entre duas fotos:
--
--   saldo_depois = saldo_antes - saiu + entradas + AJUSTE
--
-- O ajuste e a variacao de saldo dos titulos que ESTAO NAS DUAS fotos: encargo
-- que correu, pagamento parcial, renegociacao que mudou o valor. Sem ele a
-- conta nao fecha e alguem acaba somando a diferenca em "saiu" -- que seria
-- chamar correcao de encargo de recuperacao. Ele aparece com nome proprio e
-- NAO e classificado: a fonte nao diz o motivo.
--
-- A PALAVRA CONTINUA SENDO "SAIU DA BASE". Movimento observado entre duas
-- fotos do relatorio. Nao e pagamento confirmado, e a tela nao insinua que
-- seja.

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
  -- O RECORTE APROVADO, o mesmo das demais funcoes: titulo cuja origem cabe no
  -- periodo da carteira. Os de fora seguem gravados; so nao entram na conta.
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
    select l.id, l.nome, l.extraido_em, l.extraido_precisao, l.ordem_no_dia,
           row_number() over (order by public.preventivo_ordem(
             l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.criado_em, l.id)) as ordem
      from public.prev_lote l
     where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
  ), pontos as (
    select r.*,
           (select count(*) from tl where tl.lote_id = r.id) as titulos,
           (select coalesce(sum(saldo_na_remessa), 0) from tl where tl.lote_id = r.id) as saldo
      from remessas r
  ), acoes as (
    select a.id, a.nome, a.canal, a.contexto, a.origem, a.estado, a.lote_id,
           a.envio_confirmado_em, a.envio_precisao,
           coalesce(a.filtros->>'publico', 'remessa_inteira') as publico,
           l.nome as remessa_nome,
           -- A REGUA: primeira remessa COMPROVADAMENTE depois do envio.
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
    -- Quem a acao acionou, dentro do recorte, com o saldo DAQUELA remessa.
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
      -- ENTRADAS so fazem sentido quando o publico foi a remessa inteira: ai
      -- "depois" e a foto seguinte inteira. Com lista informada, o que entrou
      -- na carteira nao pertence aquela acao, entao fica nulo em vez de zero.
      case when ac.depois_id is null or ac.publico <> 'remessa_inteira' then null else (
        select count(*) from tl n where n.lote_id = ac.depois_id
          and not exists (select 1 from base b where b.acao_id = ac.id and b.titulo_id = n.titulo_id)) end as entradas_titulos,
      case when ac.depois_id is null or ac.publico <> 'remessa_inteira' then null else (
        select coalesce(sum(n.saldo_na_remessa), 0) from tl n where n.lote_id = ac.depois_id
          and not exists (select 1 from base b where b.acao_id = ac.id and b.titulo_id = n.titulo_id)) end as entradas_valor,
      -- O AJUSTE: variacao de saldo dos titulos presentes NAS DUAS fotos.
      case when ac.depois_id is null then null else (
        select coalesce(sum(n.saldo_na_remessa - b.saldo_na_remessa), 0)
          from base b join tl n on n.titulo_id = b.titulo_id and n.lote_id = ac.depois_id
         where b.acao_id = ac.id) end as ajuste_saldo,
      case when ac.depois_id is null then null else (
        select count(*) from tl n where n.lote_id = ac.depois_id) end as remessa_depois_titulos,
      case when ac.depois_id is null then null else (
        select coalesce(sum(n.saldo_na_remessa), 0) from tl n where n.lote_id = ac.depois_id) end as remessa_depois_saldo,
      -- Existe OUTRA foto no mesmo dia que nao serve de regua so por falta
      -- de hora? A remessa de onde o publico saiu nao conta: ela e anterior
      -- ao envio por construcao -- o envio nasceu dela. Sem este `<>`, toda
      -- acao enviada no dia da propria remessa se declararia pendente.
      (select count(*) > 0 from public.prev_lote l3
        where l3.carteira_id = p_carteira_id and l3.status = 'CONFIRMADO'
          and l3.id <> ac.lote_id
          and ac.envio_confirmado_em is not null
          and public.preventivo_dia(l3.extraido_em) = public.preventivo_dia(ac.envio_confirmado_em)
          and (l3.extraido_precisao <> 'DATA_E_HORA' or ac.envio_precisao <> 'DATA_E_HORA')) as mesmo_dia_sem_hora
      from acoes ac
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
      -- ALUNOS ACIONADOS, DISTINTOS. O mesmo aluno em tres envios conta UMA
      -- vez. Nulo -- nao zero -- enquanto nenhum envio estiver confirmado:
      -- zero leria como "ninguem foi acionado", e o certo e "ainda nao ha o
      -- que contar".
      'alunos_acionados', (
        select case when count(*) filter (where a.envio_confirmado_em is not null) = 0 then null
                    else count(distinct d.matricula) filter (where a.envio_confirmado_em is not null) end
          from public.prev_acao a
          join public.prev_acao_destinatario d on d.acao_id = a.id and d.incluido
          join dentro dd on dd.id = d.titulo_id
         where a.carteira_id = p_carteira_id and a.cancelada_em is null),
      'remessas', (select count(*) from pontos)),
    'pontos', coalesce((select jsonb_agg(jsonb_build_object(
        'remessa', p.id, 'nome', p.nome, 'quando', p.extraido_em,
        'precisao', p.extraido_precisao, 'ordem_no_dia', p.ordem_no_dia, 'ordem', p.ordem,
        'titulos', p.titulos, 'saldo', p.saldo
      ) order by p.ordem) from pontos p), '[]'::jsonb),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', k.id, 'nome', k.nome, 'canal', k.canal, 'contexto', k.contexto,
        'origem', k.origem, 'estado', k.estado, 'publico', k.publico,
        'quando', k.envio_confirmado_em, 'precisao', k.envio_precisao,
        'remessa_antes', k.remessa_nome,
        'remessa_depois', (select l.nome from public.prev_lote l where l.id = k.depois_id),
        'antes', jsonb_build_object('titulos', k.antes_titulos, 'saldo', k.antes_saldo,
                                    'alunos', k.antes_alunos),
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
        'sequencia_nao_comprovada', k.mesmo_dia_sem_hora
      ) order by k.envio_confirmado_em nulls last) from conta k), '[]'::jsonb),
    'definicao',
      'SAIU DA BASE = o título estava numa foto do relatório e não está na seguinte. '
   || 'É movimento observado, NÃO pagamento confirmado: pode ser pagamento, cancelamento, '
   || 'bolsa, renegociação ou mudança do recorte na origem — a fonte não distingue. '
   || 'AJUSTE DE SALDO = variação de valor dos títulos que continuam nas duas fotos '
   || '(encargo, pagamento parcial, renegociação). Ele existe para a conta fechar e NÃO é '
   || 'recuperação. A conta de cada ação é: saldo antes − saiu + entradas + ajuste = saldo depois.'
  ) into v;
  return v;
end;
$$;

comment on function public.preventivo_painel(uuid) is
  'Painel objetivo do Preventivo: quanto a carteira tinha no inicio, quanto saiu, '
  'quanto esta em aberto hoje, a serie por data e o acompanhamento por acao com a '
  'conta fechando (antes - saiu + entradas + ajuste = depois). Mesmo recorte de '
  'origem e mesma prova de sequencia das demais funcoes de leitura. Nao substitui '
  'preventivo_resultados: aquela continua viva para o detalhamento tecnico.';

revoke all on function public.preventivo_painel(uuid) from public, anon;
grant execute on function public.preventivo_painel(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- O MESMO DEFEITO NAS DUAS FUNCOES ANTIGAS
-- -----------------------------------------------------------------------------
-- `preventivo_evolucao` e `preventivo_acao_resultado` marcam a sequencia como
-- nao comprovada quando existe foto do mesmo dia do envio sem hora dos dois
-- lados. So que elas nao excluem a remessa DE ONDE A ACAO SAIU -- e essa e,
-- por construcao, anterior ao envio: o publico foi tirado dela.
--
-- Efeito pratico: toda acao enviada no mesmo dia da sua propria remessa, com
-- precisao DATA, se declarava pendente para sempre, mesmo havendo foto
-- posterior legitima. Nenhum numero fica errado -- o resultado ficava nulo --
-- mas ficava nulo sem motivo.
--
-- Patch ANCORADO: le o corpo atual e troca so o trecho. Se a ancora nao
-- bater, aborta sem aplicar nada.
do $$
declare corpo text; novo text; ancora text; troca text;
begin
  corpo := pg_get_functiondef('public.preventivo_evolucao(uuid)'::regprocedure);
  ancora := E'      (select count(*) > 0 from public.prev_lote l\n'
         || E'        where l.carteira_id = p_carteira_id and l.status = ''CONFIRMADO''\n'
         || E'          and ac.envio_confirmado_em is not null\n';
  troca  := E'      (select count(*) > 0 from public.prev_lote l\n'
         || E'        where l.carteira_id = p_carteira_id and l.status = ''CONFIRMADO''\n'
         || E'          and l.id <> ac.lote_id\n'
         || E'          and ac.envio_confirmado_em is not null\n';
  if position(ancora in corpo) = 0 then
    raise exception 'preventivo_evolucao: âncora não encontrada; nada foi alterado.';
  end if;
  novo := replace(corpo, ancora, troca);
  if novo = corpo then
    raise exception 'preventivo_evolucao: substituição não mudou o corpo.';
  end if;
  execute novo;
end $$;

do $$
declare corpo text; novo text; ancora text; troca text;
begin
  corpo := pg_get_functiondef('public.preventivo_acao_resultado(uuid)'::regprocedure);
  ancora := E'    select count(*) > 0 into v_pendente from public.prev_lote l\n'
         || E'     where l.carteira_id = v_carteira and l.status = ''CONFIRMADO''\n'
         || E'       and public.preventivo_dia(l.extraido_em) = v_dia_ancora\n';
  troca  := E'    select count(*) > 0 into v_pendente from public.prev_lote l\n'
         || E'     where l.carteira_id = v_carteira and l.status = ''CONFIRMADO''\n'
         || E'       and l.id <> v_lote\n'
         || E'       and public.preventivo_dia(l.extraido_em) = v_dia_ancora\n';
  if position(ancora in corpo) = 0 then
    raise exception 'preventivo_acao_resultado: âncora não encontrada; nada foi alterado.';
  end if;
  novo := replace(corpo, ancora, troca);
  if novo = corpo then
    raise exception 'preventivo_acao_resultado: substituição não mudou o corpo.';
  end if;
  execute novo;
end $$;
