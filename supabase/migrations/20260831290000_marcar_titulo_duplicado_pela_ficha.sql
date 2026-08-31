-- Poder tirar da conta um titulo que esta duplicado, pela ficha.
--
-- Amanda, 31/08: "eu quero poder excluir uma parcela que criou sozinha do
-- sistema. Como eu faco?". Resposta ate agora: nao dava. Nenhuma tela alterava
-- `acordos_titulos`, e das funcoes de titulo so existiam vincular e desvincular.
-- A situacao DUPLICADA ja existia (210 titulos) mas so tinha sido posta por
-- correcao via SQL, nunca por alguem na tela.
--
-- O CASO QUE MOTIVOU. Viviane Onofre Oliveira: cancelar o acordo devolveu para
-- ABERTO o boleto do PROPRIO acordo (documento 050664870001, R$ 11.088,33,
-- tipo_boleto 'Acordo', importado em 30/07 -- nao criado pelo cancelamento).
-- Como as mensalidades originais tambem voltaram, a mesma divida passou a contar
-- duas vezes.
--
-- Nao e caso isolado: 20 titulos com tipo_boleto='Acordo' estao ABERTOS, em 15
-- alunos, R$ 45.116,02. Em 6 deles ha mensalidade aberta junto -- possivel
-- duplicidade. Nos outros 9 o boleto do acordo e a UNICA representacao da divida
-- e esta certo contar. Ou seja: NAO da para corrigir em lote, precisa de olho
-- humano caso a caso. Dai a ferramenta, e nao uma migration de dados.
--
-- POR QUE MARCAR E NAO APAGAR. Apagar some com o rastro: ninguem sabe depois que
-- valor existia, quem tirou e por que. DUPLICADA mantem a linha e o valor, tira
-- da conta e registra autor, data e motivo -- mesmo formato dos 210 que ja
-- existem (`situacao` muda; `status` e valor ficam).
--
-- O MOTIVO E OBRIGATORIO. Sem ele, daqui a tres meses ninguem reconstroi a
-- decisao. Titulo PAGO e recusado de proposito: baixa errada se resolve pelo
-- Financeiro, nao marcando duplicidade.
--
-- REVERSIVEL: `titulo_desfazer_duplicada` devolve para ABERTO e registra a volta.
-- As duas recalculam o aluno no fim, senao o saldo so mudaria as 06:00.
--
-- DESFAZER: supabase/rollbacks/20260831290000_marcar_titulo_duplicado_pela_ficha.rollback.sql

create or replace function public.titulo_marcar_duplicada(
  p_titulo_id uuid,
  p_motivo    text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_aluno uuid; v_sit text; v_valor numeric; v_doc text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_motivo,''))) < 5 then
    raise exception 'Escreva o motivo -- por que este titulo esta duplicado.';
  end if;

  select t.aluno_id, upper(coalesce(t.situacao,'')), t.documento,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)
    into v_aluno, v_sit, v_doc, v_valor
    from public.acordos_titulos t where t.id = p_titulo_id;

  if v_aluno is null then
    raise exception 'Titulo nao encontrado.';
  end if;
  if v_sit = 'PAGO' then
    raise exception 'Este titulo esta PAGO -- nao marque como duplicado. Se a baixa e que esta errada, desfaca pelo Financeiro.';
  end if;
  if v_sit = 'DUPLICADA' then
    return jsonb_build_object('ok', true, 'ja_estava', true, 'aluno_id', v_aluno);
  end if;

  update public.acordos_titulos
     set situacao = 'DUPLICADA',
         motivo_ajuste = coalesce(motivo_ajuste,'')
                         || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
                         || 'marcado DUPLICADA em ' || to_char(now(),'DD/MM/YYYY')
                         || ' por ' || coalesce(nullif(v_email,''),'(sem email)')
                         || ': ' || btrim(p_motivo),
         atualizado_em = now()
   where id = p_titulo_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values
    (v_aluno::text, 'TITULO_DUPLICADO',
     'Titulo ' || coalesce(v_doc,'(sem documento)') || ' marcado como duplicado: ' || btrim(p_motivo),
     v_email, v_email, now(), v_valor);

  begin perform public.recalcular_situacao_aluno(v_aluno, 'titulo_duplicado'); exception when others then null; end;

  return jsonb_build_object('ok', true, 'aluno_id', v_aluno, 'valor_retirado', v_valor);
end;
$function$;

create or replace function public.titulo_desfazer_duplicada(
  p_titulo_id uuid,
  p_motivo    text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_aluno uuid; v_doc text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  select t.aluno_id, t.documento into v_aluno, v_doc
    from public.acordos_titulos t
   where t.id = p_titulo_id and upper(coalesce(t.situacao,'')) = 'DUPLICADA';

  if v_aluno is null then
    raise exception 'Titulo nao encontrado, ou nao esta marcado como duplicado.';
  end if;

  update public.acordos_titulos
     set situacao = 'ABERTO',
         motivo_ajuste = coalesce(motivo_ajuste,'')
                         || ' | duplicidade DESFEITA em ' || to_char(now(),'DD/MM/YYYY')
                         || ' por ' || coalesce(nullif(v_email,''),'(sem email)')
                         || coalesce(': ' || nullif(btrim(coalesce(p_motivo,'')),''), ''),
         atualizado_em = now()
   where id = p_titulo_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values
    (v_aluno::text, 'TITULO_DUPLICADO_DESFEITO',
     'Titulo ' || coalesce(v_doc,'(sem documento)') || ' voltou a contar como divida.',
     v_email, v_email, now());

  begin perform public.recalcular_situacao_aluno(v_aluno, 'titulo_duplicado_desfeito'); exception when others then null; end;

  return jsonb_build_object('ok', true, 'aluno_id', v_aluno);
end;
$function$;

revoke all on function public.titulo_marcar_duplicada(uuid, text) from public, anon;
revoke all on function public.titulo_desfazer_duplicada(uuid, text) from public, anon;
grant execute on function public.titulo_marcar_duplicada(uuid, text) to authenticated, service_role;
grant execute on function public.titulo_desfazer_duplicada(uuid, text) to authenticated, service_role;
