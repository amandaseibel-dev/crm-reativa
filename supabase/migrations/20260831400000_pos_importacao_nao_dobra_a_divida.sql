-- Depois de importar acordo, a divida nao pode ser contada duas vezes.
--
-- Amanda, 31/08, ia subir o "Relatorio Titulos em Aberto ( - )total.xls":
-- 9.466 linhas, TODAS tipo Acordo, TODAS do portador SANTANDER REATIVA -
-- CONVENIO 272047 (o 166), R$ 11.670.095,54 em 2.472 boletos e 2.297 CPFs.
--
-- O PERIGO. `importar_acordos` grava fixo `'ABERTO','vinculada'` e NAO cria
-- vinculo. E o titulo de acordo ABERTO **sem vinculo** e exatamente o estado que
-- SOMA no saldo -- medido: dos 528 titulos de acordo de hoje, os 490 NEGOCIADO
-- tem vinculo ativo e nao contam; os 6 ABERTO sem vinculo contam (R$ 6.295,86).
--
-- Subir os 9.466 assim somaria R$ 11,67 mi ao saldo POR CIMA das parcelas dos
-- mesmos acordos, que ja somam R$ 11,27 mi. A carteira saltaria de
-- R$ 47.116.940,36 para quase R$ 59 mi -- e a Amanda tinha acabado de mandar os
-- relatorios de fechamento para a diretoria com o numero atual. Ficaria assim
-- ate alguem confirmar 2.472 acordos na fila, um a um.
--
-- O QUE ESTA ROTINA FAZ, na ordem:
--   1. titulo cujo documento aparece no extrato Santander -> PAGO. Ja foi pago,
--      nao e divida. (O arquivo e uma FOTO de 31/07/2026 -- conferido nos
--      metadados -- entao tudo que foi pago em agosto ainda vem como "em
--      aberto" nele.)
--   2. o que sobra casa com a PARCELA do acordo pelos 4 ultimos digitos do
--      documento, ganha o boleto e o vinculo, e vira NEGOCIADO. A divida passa
--      a ser contada UMA vez, pela parcela.
--   3. recalculo por ULTIMO.
--
-- Validado nos 6 titulos que hoje estao nesse estado: 5 casam com a parcela
-- certa (Gilberto na 7, Guilherme na 6, Maria Eduarda / Claudia / Kelly na 1) e
-- nenhum aparece pago no extrato. So Caio Matheus nao casa.
--
-- Sem p_confirmar a funcao SO CONTA. Backup antes de escrever.
--
-- PORQUE O ARQUIVO DA AMANDA E INSUBSTITUIVEL: o Prime NAO devolve parcela do
-- portador 166 (+9.000 varridas, zero; /agreements vazio em 100%). Esse
-- relatorio e a unica fonte dos boletos de acordo. Ver
-- [[prime-so-portadores-166-e-195]].

create or replace function public.acordos_pos_importacao(
  p_importacao_id uuid default null,
  p_confirmar boolean default false
)
returns jsonb
language plpgsql security definer
set search_path to 'public' set statement_timeout to '600s'
as $function$
declare
  v_pagos int := 0; v_amarrados int := 0; v_vinculados int := 0; v_alunos int := 0;
  v_valor_pago numeric := 0; v_valor_vinc numeric := 0; v_lote text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _alvo on commit drop as
  select t.id, t.aluno_id, t.documento, ltrim(t.documento,'0') chave,
         (right(t.documento,4))::int nr,
         coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) valor
    from public.acordos_titulos t
   where coalesce(t.tipo_boleto,'')='Acordo'
     and upper(coalesce(t.situacao,''))='ABERTO'
     and t.documento ~ '^\d{12}$'
     and (p_importacao_id is null or t.importacao_id = p_importacao_id)
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id=t.id and coalesce(v.ativo,true));

  create temp table _pago on commit drop as
  select distinct a.id, a.aluno_id, a.valor, p.data_pagamento
    from _alvo a join public.pagamentos p
      on ltrim(coalesce(p.numero_parcela_completo,''),'0') = a.chave;

  create temp table _casa on commit drop as
  select distinct on (a.id) a.id titulo_id, a.aluno_id, a.chave, a.valor,
         pa.id parcela_id, pa.acordo_id
    from _alvo a
    join public.acordos ac on ac.aluno_id = a.aluno_id
    join public.parcelas pa on pa.acordo_id = ac.id and pa.numero = a.nr
   where not exists (select 1 from _pago pg where pg.id = a.id)
     and abs(pa.valor - a.valor) <= 0.05
     and pa.boleto is null
   order by a.id, abs(pa.valor - a.valor);

  select count(*), round(coalesce(sum(valor),0),2) into v_pagos, v_valor_pago from _pago;
  select count(*), round(coalesce(sum(valor),0),2) into v_vinculados, v_valor_vinc from _casa;
  select count(distinct aluno_id) into v_alunos
    from (select aluno_id from _pago union select aluno_id from _casa) x;

  if not coalesce(p_confirmar,false) then
    return jsonb_build_object('modo','previa',
      'titulos_no_alvo', (select count(*) from _alvo),
      'ja_pagos_no_extrato', v_pagos, 'valor_ja_pago', v_valor_pago,
      'casam_com_parcela', v_vinculados, 'valor_a_vincular', v_valor_vinc,
      'sobram_sem_tratamento',
        (select count(*) from _alvo a where not exists (select 1 from _pago p where p.id=a.id)
           and not exists (select 1 from _casa c where c.titulo_id=a.id)),
      'alunos', v_alunos);
  end if;

  v_lote := to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
     select t.*, now() salvo_em from public.acordos_titulos t
      where t.id in (select id from _alvo)', '_backup_pos_import_' || v_lote);

  update public.acordos_titulos t
     set situacao='PAGO', status='quitada',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'importado em aberto, mas o extrato Santander mostra pagamento do documento '
           || t.documento,
         atualizado_em = now()
    from _pago p where p.id = t.id;
  get diagnostics v_pagos = row_count;

  update public.parcelas pa set boleto = c.chave, atualizado_em = now()
    from _casa c where pa.id = c.parcela_id and pa.boleto is null;
  get diagnostics v_amarrados = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo)
  select c.acordo_id, c.titulo_id, true from _casa c
   where not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id=c.titulo_id and v.acordo_id=c.acordo_id);

  update public.acordos_titulos t
     set situacao='NEGOCIADO', status='vinculada', acordo_id = c.acordo_id, atualizado_em = now()
    from _casa c where t.id = c.titulo_id;
  get diagnostics v_vinculados = row_count;

  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select aluno_id from _pago union select aluno_id from _casa) x;

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'marcados_pagos', v_pagos, 'boletos_amarrados', v_amarrados,
    'vinculados', v_vinculados, 'alunos', v_alunos,
    'backup', '_backup_pos_import_' || v_lote);
end;
$function$;

revoke all on function public.acordos_pos_importacao(uuid, boolean) from public, anon;
grant execute on function public.acordos_pos_importacao(uuid, boolean) to authenticated, service_role;
