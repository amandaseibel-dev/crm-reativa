-- GRUPO A, ETAPA 2 -- LOTE PILOTO REAL (5 titulos). Autorizado pela gestao em 18/09/2026.
-- Usa a funcao oficial prime_conferencia_detectar_grupo_a(true, ids). Qualquer
-- conferencia abaixo que falhe desfaz TUDO (raise dentro da mesma transacao).
do $piloto$
declare
  v_ids    uuid[] := array['39f8f6d2-1eb7-4db2-accc-9dde22e98809','8761049a-a5df-4ed3-8129-02df946e3739','b1a12069-51b1-48ac-b51c-b42f340d22bb','8e21c9d0-5866-4d23-85da-9cc5f02bbec7','b91eff89-97e6-4efd-aebb-bd4e5f5adae6']::uuid[];
  v_alunos uuid[] := array['01aec775-928b-42ae-9e6b-9c7de739c356','05356d3f-b95e-4770-b32d-624efdeabc2e','0a34c9e6-45d4-48a1-bd74-64289078e3b2','0e292413-9751-44df-b841-bf63efb8deef','b2ddae46-32bc-4702-8843-eae8b42f1b27']::uuid[];
  v_res    jsonb;
  v_fila   bigint;
  v_n      int;
begin
  if (select count(*) from public.acordos_titulos where id = any(v_ids)
        and upper(coalesce(situacao,'')) = 'ABERTO' and lower(coalesce(status,'')) = 'em_aberto') <> 5 then
    raise exception 'PILOTO_PRE: os 5 titulos nao estao todos ABERTO/em_aberto';
  end if;
  if exists (select 1 from public.prime_conferencia_decisao where titulo_id = any(v_ids)) then
    raise exception 'PILOTO_PRE: ja existe decisao para titulo do piloto';
  end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> 0 then
    raise exception 'PILOTO_PRE: ja existe titulo em EM_CONFIRMACAO';
  end if;

  create temp table _pil_t on commit drop as
    select id, valor_original, saldo_corrigido, valor_em_aberto, valor_cobranca_ajustado, acordo_id, aluno_id, documento, vencimento
      from public.acordos_titulos where id = any(v_ids);
  create temp table _pil_c on commit drop as
    select id, aluno_id, operador_email, encerrado_operacional from public.casos where aluno_id = any(v_alunos);
  create temp table _pil_a on commit drop as
    select id, status_atual, status_jornada, responsavel_atual_email from public.alunos where id = any(v_alunos);
  select coalesce(max(id), 0) into v_fila from public.reposicao_carteira_fila;

  v_res := public.prime_conferencia_detectar_grupo_a(true, v_ids);

  if coalesce((v_res->>'suspensos')::int, -1) <> 5 or (v_res->>'A1')::int <> 4 or (v_res->>'A2_COBRE')::int <> 1
     or (v_res->>'revisao_obrigatoria')::int <> 1 then
    raise exception 'PILOTO: resultado inesperado %', v_res;
  end if;
  -- titulos: so a situacao muda; valores, acordo e origem ficam
  select count(*) into v_n from public.acordos_titulos t join _pil_t p on p.id = t.id
   where t.situacao = 'EM_CONFIRMACAO' and t.status = 'em_confirmacao'
     and t.valor_original is not distinct from p.valor_original and t.saldo_corrigido is not distinct from p.saldo_corrigido
     and t.valor_em_aberto is not distinct from p.valor_em_aberto and t.valor_cobranca_ajustado is not distinct from p.valor_cobranca_ajustado
     and t.acordo_id is not distinct from p.acordo_id and t.origem_liquidacao is null
     and t.aluno_id = p.aluno_id and t.documento = p.documento and t.vencimento = p.vencimento;
  if v_n <> 5 then raise exception 'PILOTO: titulos fora do esperado (% de 5)', v_n; end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> 5 then
    raise exception 'PILOTO: EM_CONFIRMACAO fora do piloto';
  end if;
  -- casos: abertos e com o mesmo responsavel
  if exists (select 1 from public.casos c join _pil_c p on p.id = c.id
              where c.operador_email is distinct from p.operador_email or c.encerrado_operacional is distinct from p.encerrado_operacional) then
    raise exception 'PILOTO: caso mudou de responsavel ou foi encerrado';
  end if;
  -- alunos: status e responsavel intactos; ninguem QUITADO
  if exists (select 1 from public.alunos a join _pil_a p on p.id = a.id
              where a.status_atual is distinct from p.status_atual or a.status_jornada is distinct from p.status_jornada
                 or a.responsavel_atual_email is distinct from p.responsavel_atual_email) then
    raise exception 'PILOTO: aluno mudou de status ou responsavel';
  end if;
  -- quem ficou so com a confirmacao aguarda; quem tem outra divida segue em cobranca
  if (select count(*) from public.alunos where id = any(array['01aec775-928b-42ae-9e6b-9c7de739c356','05356d3f-b95e-4770-b32d-624efdeabc2e']::uuid[])
        and situacao_operacional = 'AGUARDANDO_CONFIRMACAO') <> 2 then
    raise exception 'PILOTO: aluno so com confirmacao nao ficou AGUARDANDO_CONFIRMACAO';
  end if;
  if exists (select 1 from public.alunos where id = any(v_alunos) and upper(coalesce(situacao_operacional,'')) like 'QUITADO%') then
    raise exception 'PILOTO: aluno virou QUITADO';
  end if;
  -- nenhuma reposicao enfileirada
  if (select coalesce(max(id), 0) from public.reposicao_carteira_fila) <> v_fila then
    raise exception 'PILOTO: reposicao enfileirada';
  end if;
  -- decisoes PENDENTE com a classificacao esperada
  if (select count(*) from public.prime_conferencia_decisao where titulo_id = any(v_ids) and decisao = 'PENDENTE'
        and motivo_entrada = 'LIQUIDACAO_PRIME_CORROBORADA') <> 5
     or (select subgrupo from public.prime_conferencia_decisao where titulo_id = '8e21c9d0-5866-4d23-85da-9cc5f02bbec7') <> 'A2_COBRE'
     or not (select revisao_obrigatoria from public.prime_conferencia_decisao where titulo_id = 'b91eff89-97e6-4efd-aebb-bd4e5f5adae6') then
    raise exception 'PILOTO: decisoes fora do esperado';
  end if;
end;
$piloto$;

