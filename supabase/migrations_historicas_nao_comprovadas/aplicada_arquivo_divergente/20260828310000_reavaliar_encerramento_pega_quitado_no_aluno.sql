-- Caso quitado que nao saia da fila -- segunda causa.
--
-- Amanda: "veja se os casos que estou quitado total esta saindo?".
--
-- Medido: 277 quitacoes desde ontem, 275 com saldo zerado -- mas 58 casos
-- seguiam NA FILA com saldo zero.
--
-- POR QUE. O botao "Quitar tudo" antigo (corrigido no PR #253) atualizava o
-- ALUNO e os TITULOS, mas nao escrevia no CASO. O caso ficava com o status
-- velho do operador ("Mensagem enviada", "Em negociacao"...) e a regra
-- `caso_encerrado_operacional`, que le o status do CASO, dizia "nao encerrado".
--
-- A varredura `casos_reavaliar_encerramento` tambem nao pegava: exigia que a
-- regra dissesse encerrado E que o saldo canonico fosse zero. Com a regra
-- dizendo nao, nunca fechava.
--
-- Agora fecha tambem quando: saldo canonico ZERO e o ALUNO marcado como
-- quitado/baixa. Conferido nos 58: em TODOS o aluno ja estava marcado.
--
-- A trava que nao muda: exige saldo canonico zero. Nunca fecha quem deve.

create or replace function public.casos_reavaliar_encerramento(p_limite integer default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $$
declare v_n integer;
begin
  with alvo as (
    select c.id
      from public.casos c
      join public.alunos al on al.id = c.aluno_id
     where not coalesce(c.encerrado_operacional, false)
       and c.aluno_id is not null
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric <= 0.005
       and (
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada)
         or upper(coalesce(al.status_atual,'')) ~ 'QUIT|BAIXA|SALDO_ZERO|SEM_SALDO'
       )
     limit coalesce(p_limite, 100000)
  )
  update public.casos c
     set encerrado_operacional = true,
         caso_atualizado_por = 'sistema_reavaliar_encerramento',
         caso_atualizado_em = now()
    from alvo a
   where c.id = a.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.casos_reavaliar_encerramento(integer) from public, anon, authenticated;
grant execute on function public.casos_reavaliar_encerramento(integer) to service_role;
