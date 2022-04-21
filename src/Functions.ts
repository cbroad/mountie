import FS from "fs";

export async function isDirectory( path:string ) {
    return FS.promises.stat( path )
        .then( ( stats:FS.Stats ) => stats.isDirectory() )
        .catch( ( err:any ) => false );
}


export async function sleep( ms:number ):Promise<void>;
export async function sleep( ms:number, signal:AbortSignal|undefined ):Promise<void>;
export async function sleep( ms:number, signal?:AbortSignal ):Promise<void> {
    let resolve:(value:void|PromiseLike<void>)=>void|undefined;
    const promise = new Promise<void>( res => resolve = res );
    const timeout = setTimeout( resolve!, ms )
    if( signal ) {
        signal.addEventListener( "abort", onAbort );
        promise.then( () => { signal.removeEventListener( "abort", onAbort ); } );
    }
    return promise;

    function onAbort() {
        clearTimeout( timeout! );
        resolve();
    }
}