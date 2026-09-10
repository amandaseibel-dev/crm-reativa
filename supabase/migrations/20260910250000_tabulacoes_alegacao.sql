-- TABULACOES DE ALEGACAO (FIES, CREDIES, financiamento, antecipacao de semestre)
--
-- Pedido da gestao em 10/09/2026. Sao alegacoes do aluno que precisam ser
-- conferidas com a unidade antes de continuar cobrando -- e o fluxo e sempre o
-- mesmo: o operador registra, o caso vai para a Amanda ADM, que encaminha ao
-- financeiro; passados 20 dias sem resposta, o caso volta a fila dela para
-- cobrar o retorno da unidade.
--
-- Duas decisoes da gestao vao junto:
--   * BLOQUEIA o acionamento -- nao se cobra aluno enquanto se apura se ele
--     realmente tem FIES ou financiamento.
--   * REDIRECIONA para a Amanda ADM -- e por isso a coluna nova: ate aqui o
--     catalogo dizia o prazo e a proxima acao, mas nao sabia trocar o dono.
--
-- O grupo ALEGACAO entra na constraint porque o front usa o nome do grupo como
-- rotulo do optgroup: sem grupo proprio, elas cairiam no meio do financeiro.
alter table public.tabulacoes drop constraint if exists tabulacoes_grupo_valido;
alter table public.tabulacoes add constraint tabulacoes_grupo_valido
  check (grupo = any (array['CONTATO','LINK','TERMO','FINANCEIRO','ENCERRAMENTO','ALEGACAO']));

alter table public.tabulacoes
  add column if not exists redireciona_para_email text;

comment on column public.tabulacoes.redireciona_para_email is
  'Ao tabular, o caso passa para este usuario. Usado nas alegacoes que a gestao apura (FIES, CREDIES, financiamento, antecipacao), que vao para a ADM encaminhar ao financeiro.';

insert into public.tabulacoes
  (codigo, rotulo, ativa, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   bloqueia_acionamento, sistema, redireciona_para_email, criado_por)
values
  ('ALEGA_FIES', 'Alega FIES', true, 510, 'ALEGACAO', 'DIAS_UTEIS', 20, 'AGUARDAR_RETORNO_UNIDADE',
   true, false, 'cobranca07@aelbra.com.br', 'gestao 10/09/2026'),
  ('ALEGA_CREDIES', 'Alega CREDIES', true, 520, 'ALEGACAO', 'DIAS_UTEIS', 20, 'AGUARDAR_RETORNO_UNIDADE',
   true, false, 'cobranca07@aelbra.com.br', 'gestao 10/09/2026'),
  ('ALEGA_FINANCIAMENTO', 'Alega financiamento', true, 530, 'ALEGACAO', 'DIAS_UTEIS', 20, 'AGUARDAR_RETORNO_UNIDADE',
   true, false, 'cobranca07@aelbra.com.br', 'gestao 10/09/2026'),
  ('ANTECIPACAO_SEMESTRE', 'Antecipação de semestre', true, 540, 'ALEGACAO', 'DIAS_UTEIS', 20, 'AGUARDAR_RETORNO_UNIDADE',
   true, false, 'cobranca07@aelbra.com.br', 'gestao 10/09/2026')
on conflict (codigo) do update
  set rotulo = excluded.rotulo, ativa = excluded.ativa, ordem = excluded.ordem,
      grupo = excluded.grupo, retorno_modo = excluded.retorno_modo,
      retorno_dias_uteis = excluded.retorno_dias_uteis, proxima_acao = excluded.proxima_acao,
      bloqueia_acionamento = excluded.bloqueia_acionamento,
      redireciona_para_email = excluded.redireciona_para_email,
      atualizado_em = now();

-- Redireciona ao tabular, em qualquer tela: a tabulacao e gravada em
-- `alunos.status_jornada` por mais de um caminho (carteira, ficha, modal), e
-- repetir a regra em cada um deles seria esquece-la no proximo.
create or replace function public.trg_tabulacao_redireciona()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_destino text; v_nome text; v_ant_email text; v_ant_nome text;
begin
  if new.status_jornada is not distinct from old.status_jornada then
    return new;
  end if;

  select t.redireciona_para_email into v_destino
    from public.tabulacoes t
   where t.codigo = new.status_jornada and t.ativa and t.redireciona_para_email is not null;
  if v_destino is null then return new; end if;

  if lower(coalesce(new.responsavel_atual_email,'')) = lower(v_destino) then
    return new;
  end if;

  select nome into v_nome from public.usuarios where lower(email) = lower(v_destino) and ativo;
  if v_nome is null then return new; end if;

  v_ant_email := new.responsavel_atual_email;
  v_ant_nome  := new.responsavel_atual_nome;

  -- NAO usa internal.set_resp_aluno de proposito: aquela funcao ZERA
  -- data_retorno, proxima_acao e status_acionamento quando o responsavel muda,
  -- e apagaria justamente o retorno de 20 dias que a tabulacao acabou de
  -- agendar. Aqui a troca preserva o agendamento.
  update public.alunos
     set responsavel_atual_email = lower(v_destino),
         responsavel_atual_nome  = v_nome,
         responsavel_atual_em    = now(),
         operador_email = lower(v_destino),
         operador_nome  = v_nome,
         operador       = v_nome
   where id = new.id;

  update public.casos
     set operador_email = lower(v_destino), operador_nome = v_nome, operador = upper(v_nome)
   where aluno_id = new.id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, operador_anterior_nome, operador_anterior_email,
     operador_novo_nome, operador_novo_email, registrado_por_nome, registrado_por_email, registrado_em)
  values (new.id::text, 'ALEGACAO_ENCAMINHADA',
    'Tabulado como "' || new.status_jornada || '": caso encaminhado a ' || v_nome ||
    ' para envio ao financeiro. Retorno em 20 dias úteis para cobrar a unidade.',
    coalesce(v_ant_nome,'(sem)'), v_ant_email, v_nome, lower(v_destino),
    coalesce(v_ant_nome, v_ant_email, 'sistema'), coalesce(v_ant_email,'sistema'), now());

  return new;
end;
$$;

drop trigger if exists trg_tabulacao_redireciona on public.alunos;
create trigger trg_tabulacao_redireciona
  after update of status_jornada on public.alunos
  for each row execute function public.trg_tabulacao_redireciona();
