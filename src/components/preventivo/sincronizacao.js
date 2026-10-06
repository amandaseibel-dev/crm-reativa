// O LAÇO DA ATUALIZAÇÃO COM O PRIME, fora do componente para poder ser testado
// sem montar React e sem rede.
//
// POR QUE ISTO EXISTE. A Edge Function tem teto de ~110s por chamada e devolve
// `concluido: false` quando parou no tempo — quem continua é quem chamou. Até
// aqui o ponteiro do ciclo (`sinc_id`) vivia só dentro do laço: fechou a aba,
// perdeu o ponteiro, e o clique seguinte abria um ciclo NOVO, re-enfileirando
// quem já tinha sido consultado.
//
// Medido em produção em 06/10/2026: o ciclo 7dd0ae95 ficou 14h45 em
// EM_ANDAMENTO com 1.424 de 10.761 alunos coletados. Recomeçar custaria
// refazer essas 1.424 consultas à API da ULBRA.
//
// Agora o ciclo em andamento vem de `preventivo_sinc_situacao`, que já o
// devolve com id — a tela só não estava usando.
//
// O QUE NÃO MUDA: nada no banco e nada na Edge Function. Quem garante que
// ninguém é consultado duas vezes é `preventivo_sinc_alvos`, que só entrega
// linha com `coletado_em is null`. Aqui só se escolhe o ponto de partida.

export const VOLTAS_MAXIMAS = 40;

// `invocar` é a função que fala com a Edge Function — injetada para o teste.
// `sincId` não-nulo = RETOMAR aquele ciclo; nulo = abrir um novo.
export async function rodarSincronizacao(invocar, { carteiraId, sincId = null,
                                                    voltasMaximas = VOLTAS_MAXIMAS } = {}) {
  let atual = sincId;
  let voltas = 0;
  let concluido = false;

  for (let volta = 0; volta < voltasMaximas; volta++) {
    voltas += 1;
    // Com um ciclo em mãos, NUNCA se manda carteira_id/origem: esse corpo é o
    // que faz a Edge Function abrir ciclo novo.
    const corpo = atual ? { sinc_id: atual } : { carteira_id: carteiraId, origem: "manual" };
    const { data, error } = await invocar(corpo);
    if (error) throw error;
    atual = data?.sinc_id ?? atual;
    if (data?.concluido) { concluido = true; break; }
  }

  return { sincId: atual, concluido, voltas };
}
