const { Mountie } = require( ".." );

(async function main() {
    const mountie = new Mountie();

    // await mountie.nextRefresh();

    for await ( const event of mountie ) {
        console.log( event );
    }
} )();

async function sleep( ms ) { return new Promise( resolve => setTimeout( resolve, ms ) ) }
